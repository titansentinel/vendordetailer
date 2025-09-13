import { storage } from '../storage';
import { createShopifyService } from './shopify';
import { logger } from '../utils/logger';
import type { BulkJob, InsertBulkJob } from '@shared/schema';

export class BulkJobProcessor {
  private processingJobs = new Set<string>();

  async createJob(jobData: InsertBulkJob): Promise<BulkJob> {
    const job = await storage.createBulkJob(jobData);
    
    // Start processing the job asynchronously
    this.processJob(job.id).catch(error => {
      logger.error('Job processing failed', {
        jobId: job.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    });

    return job;
  }

  async getJob(id: string): Promise<BulkJob | undefined> {
    return storage.getBulkJob(id);
  }

  async getJobStatus(id: string): Promise<{ 
    job: BulkJob | undefined; 
    progress: number; 
    isProcessing: boolean; 
  }> {
    const job = await storage.getBulkJob(id);
    const progress = job ? (job.processedCount || 0) / job.totalCount : 0;
    const isProcessing = this.processingJobs.has(id);

    return {
      job,
      progress: Math.round(progress * 100),
      isProcessing,
    };
  }

  private async processJob(jobId: string): Promise<void> {
    if (this.processingJobs.has(jobId)) {
      logger.warn('Job already being processed', { jobId });
      return;
    }

    this.processingJobs.add(jobId);

    try {
      const job = await storage.getBulkJob(jobId);
      if (!job) {
        throw new Error('Job not found');
      }

      logger.info('Starting job processing', {
        jobId,
        shopDomain: job.shopDomain,
        productCount: job.productIds.length,
        targetVendor: job.targetVendor,
      });

      // Update job status to RUNNING
      await storage.updateBulkJob(jobId, { status: 'RUNNING' });

      // Get shop settings to retrieve access token
      const shopSettings = await storage.getShopSettings(job.shopDomain);
      if (!shopSettings?.accessToken) {
        throw new Error('Shop access token not found');
      }

      const shopifyService = createShopifyService(job.shopDomain, shopSettings.accessToken);

      // Process products in batches to avoid rate limits
      const batchSize = 50;
      let processedCount = 0;

      for (let i = 0; i < job.productIds.length; i += batchSize) {
        const batch = job.productIds.slice(i, i + batchSize);
        
        try {
          const result = await shopifyService.bulkUpdateVendor(batch, job.targetVendor);
          
          if (result.productBulkUpdate.userErrors.length > 0) {
            logger.warn('Batch update had errors', {
              jobId,
              batch: i / batchSize + 1,
              errors: result.productBulkUpdate.userErrors,
            });
          }

          processedCount += batch.length;
          
          // Update progress
          await storage.updateBulkJob(jobId, { 
            processedCount,
          });

          // Add delay to respect rate limits
          if (i + batchSize < job.productIds.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

        } catch (error) {
          logger.error('Batch processing failed', {
            jobId,
            batch: i / batchSize + 1,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          
          // Continue with next batch instead of failing entire job
          processedCount += batch.length;
        }
      }

      // Mark job as completed
      await storage.updateBulkJob(jobId, {
        status: 'SUCCESS',
        processedCount,
        completedAt: new Date(),
      });

      logger.info('Job completed successfully', {
        jobId,
        processedCount,
        totalCount: job.totalCount,
      });

    } catch (error) {
      logger.error('Job processing failed', {
        jobId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      await storage.updateBulkJob(jobId, {
        status: 'FAILED',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        completedAt: new Date(),
      });
    } finally {
      this.processingJobs.delete(jobId);
    }
  }

  async retryJob(jobId: string): Promise<BulkJob> {
    const job = await storage.getBulkJob(jobId);
    if (!job) {
      throw new Error('Job not found');
    }

    if (job.status === 'RUNNING') {
      throw new Error('Job is currently running');
    }

    // Reset job status and counters
    const updatedJob = await storage.updateBulkJob(jobId, {
      status: 'PENDING',
      processedCount: 0,
      errorMessage: null,
      completedAt: null,
    });

    // Start processing again
    this.processJob(jobId).catch(error => {
      logger.error('Job retry failed', {
        jobId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    });

    return updatedJob;
  }

  async cancelJob(jobId: string): Promise<BulkJob> {
    const job = await storage.getBulkJob(jobId);
    if (!job) {
      throw new Error('Job not found');
    }

    if (job.status !== 'RUNNING' && job.status !== 'PENDING') {
      throw new Error('Job cannot be cancelled in current status');
    }

    // Remove from processing set
    this.processingJobs.delete(jobId);

    return storage.updateBulkJob(jobId, {
      status: 'FAILED',
      errorMessage: 'Job cancelled by user',
      completedAt: new Date(),
    });
  }

  async getRecentJobs(shopDomain?: string, limit = 10): Promise<BulkJob[]> {
    return storage.getRecentBulkJobs(shopDomain, limit);
  }

  async getPendingJobs(): Promise<BulkJob[]> {
    return storage.getBulkJobsByStatus('PENDING');
  }

  async getRunningJobs(): Promise<BulkJob[]> {
    return storage.getBulkJobsByStatus('RUNNING');
  }
}

export const bulkJobProcessor = new BulkJobProcessor();
