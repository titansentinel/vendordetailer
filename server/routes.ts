import type { Express } from "express";
import { createServer, type Server } from "http";
import { z } from "zod";
import { storage } from "./storage";
import { bulkJobProcessor } from "./services/bulk-jobs";
import { csvExportService } from "./services/csv-export";
import { authService } from "./services/auth";
import { createShopifyService } from "./services/shopify";
import { logger } from "./utils/logger";
import { 
  generalApiLimiter, 
  bulkOperationLimiter, 
  exportLimiter, 
  shopifyApiLimiter 
} from "./middleware/rate-limit";

export async function registerRoutes(app: Express): Promise<Server> {
  // Apply general rate limiting to all API routes
  app.use('/api', generalApiLimiter.middleware());

  // Middleware to log API calls
  app.use('/api', async (req, res, next) => {
    const start = Date.now();
    
    res.on('finish', async () => {
      const responseTime = Date.now() - start;
      
      try {
        await storage.createApiLog({
          endpoint: req.path,
          method: req.method,
          statusCode: res.statusCode,
          responseTime,
          shopDomain: req.headers['x-shop-domain'] as string || req.body?.shopDomain,
          errorMessage: res.statusCode >= 400 ? res.statusMessage : undefined,
        });
      } catch (error) {
        logger.error('Failed to log API call', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    next();
  });

  // Health check endpoint
  app.get('/api/health', async (req, res) => {
    try {
      const stats = await storage.getSystemStats();
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        stats,
      });
    } catch (error) {
      logger.error('Health check failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({
        status: 'unhealthy',
        error: 'Database connection failed',
      });
    }
  });

  // Get distinct vendor list (cached)
  app.get('/api/vendors', shopifyApiLimiter.middleware(), async (req, res) => {
    try {
      const { shopDomain } = req.query;
      
      if (!shopDomain || typeof shopDomain !== 'string') {
        return res.status(400).json({ error: 'shopDomain is required' });
      }

      // Get cached vendors from database
      let vendors = await storage.getVendors(shopDomain);
      
      // If no vendors in cache or cache is old, refresh from Shopify
      if (vendors.length === 0) {
        const shopSettings = await storage.getShopSettings(shopDomain);
        
        if (!shopSettings?.accessToken) {
          return res.status(401).json({ error: 'Shop not authenticated' });
        }

        const shopifyService = createShopifyService(shopDomain, shopSettings.accessToken);
        const shopifyVendors = await shopifyService.getAllVendors();
        
        // Update vendor cache
        for (const vendorName of shopifyVendors) {
          const existingVendor = await storage.getVendorByName(shopDomain, vendorName);
          
          if (!existingVendor) {
            await storage.createVendor({
              shopDomain,
              name: vendorName,
              productCount: 0,
            });
          }
        }
        
        vendors = await storage.getVendors(shopDomain);
      }

      res.json({ vendors: vendors.map(v => v.name) });
    } catch (error) {
      logger.error('Failed to get vendors', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({ error: 'Failed to fetch vendors' });
    }
  });

  // Bulk update vendor
  app.post('/api/bulk-update-vendor', bulkOperationLimiter.middleware(), async (req, res) => {
    try {
      const schema = z.object({
        shopDomain: z.string(),
        productIds: z.array(z.string()).min(1),
        vendor: z.string().min(1),
      });

      const { shopDomain, productIds, vendor } = schema.parse(req.body);

      // Validate shop access
      const hasAccess = await authService.validateShopAccess(shopDomain);
      if (!hasAccess) {
        return res.status(401).json({ error: 'Shop not authenticated' });
      }

      // Create bulk job
      const job = await bulkJobProcessor.createJob({
        shopDomain,
        productIds,
        targetVendor: vendor,
        status: 'PENDING',
        totalCount: productIds.length,
      });

      logger.bulkJobStart(job.id, shopDomain, productIds.length);

      res.json({
        jobId: job.id,
        status: job.status,
        message: 'Bulk update job created successfully',
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Invalid request data',
          details: error.errors,
        });
      }

      logger.error('Bulk update failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({ error: 'Failed to create bulk update job' });
    }
  });

  // Get bulk job status
  app.get('/api/bulk-jobs/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const jobStatus = await bulkJobProcessor.getJobStatus(id);

      if (!jobStatus.job) {
        return res.status(404).json({ error: 'Job not found' });
      }

      res.json({
        job: jobStatus.job,
        progress: jobStatus.progress,
        isProcessing: jobStatus.isProcessing,
      });
    } catch (error) {
      logger.error('Failed to get job status', {
        jobId: req.params.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({ error: 'Failed to get job status' });
    }
  });

  // Get recent bulk jobs
  app.get('/api/bulk-jobs', async (req, res) => {
    try {
      const { shopDomain, limit } = req.query;
      
      const jobs = await bulkJobProcessor.getRecentJobs(
        shopDomain as string,
        limit ? parseInt(limit as string) : undefined
      );

      res.json({ jobs });
    } catch (error) {
      logger.error('Failed to get bulk jobs', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({ error: 'Failed to fetch bulk jobs' });
    }
  });

  // Retry bulk job
  app.post('/api/bulk-jobs/:id/retry', async (req, res) => {
    try {
      const { id } = req.params;
      const job = await bulkJobProcessor.retryJob(id);
      
      res.json({
        job,
        message: 'Job retry initiated',
      });
    } catch (error) {
      logger.error('Failed to retry job', {
        jobId: req.params.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(400).json({ 
        error: error instanceof Error ? error.message : 'Failed to retry job',
      });
    }
  });

  // Cancel bulk job
  app.post('/api/bulk-jobs/:id/cancel', async (req, res) => {
    try {
      const { id } = req.params;
      const job = await bulkJobProcessor.cancelJob(id);
      
      res.json({
        job,
        message: 'Job cancelled successfully',
      });
    } catch (error) {
      logger.error('Failed to cancel job', {
        jobId: req.params.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(400).json({ 
        error: error instanceof Error ? error.message : 'Failed to cancel job',
      });
    }
  });

  // Export products
  app.post('/api/export', exportLimiter.middleware(), async (req, res) => {
    try {
      const schema = z.object({
        shopDomain: z.string(),
        vendor: z.string().optional(),
        filters: z.object({
          status: z.string().optional(),
          productType: z.string().optional(),
        }).optional(),
      });

      const { shopDomain, vendor, filters } = schema.parse(req.body);

      // Validate shop access
      const hasAccess = await authService.validateShopAccess(shopDomain);
      if (!hasAccess) {
        return res.status(401).json({ error: 'Shop not authenticated' });
      }

      logger.exportRequest(shopDomain, vendor, filters);

      const signedUrl = await csvExportService.exportProducts({
        shopDomain,
        vendor,
        filters,
      });

      res.json({
        downloadUrl: signedUrl,
        message: 'Export created successfully',
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Invalid request data',
          details: error.errors,
        });
      }

      logger.error('Export failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({ error: 'Failed to create export' });
    }
  });

  // Download exported CSV
  app.get('/api/export/download/:exportId', async (req, res) => {
    try {
      const { exportId } = req.params;
      const { token } = req.query;

      if (!token || typeof token !== 'string') {
        return res.status(400).json({ error: 'Missing export token' });
      }

      // Verify token
      const tokenData = csvExportService.verifyExportToken(token);
      
      // Get CSV content
      const csvContent = await csvExportService.getCsvContent(exportId);
      
      if (!csvContent) {
        return res.status(404).json({ error: 'Export not found or expired' });
      }

      // Set headers for CSV download
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="products-export-${exportId}.csv"`);
      res.send(csvContent);

      logger.info('CSV download completed', {
        exportId,
        shopDomain: tokenData.shopDomain,
      });
    } catch (error) {
      logger.error('CSV download failed', {
        exportId: req.params.exportId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(400).json({ error: 'Invalid or expired download link' });
    }
  });

  // Get shop settings
  app.get('/api/settings', async (req, res) => {
    try {
      const { shopDomain } = req.query;
      
      if (!shopDomain || typeof shopDomain !== 'string') {
        return res.status(400).json({ error: 'shopDomain is required' });
      }

      const settings = await storage.getShopSettings(shopDomain);
      
      if (!settings) {
        return res.status(404).json({ error: 'Shop settings not found' });
      }

      // Return settings without sensitive data
      res.json({
        shopDomain: settings.shopDomain,
        showVendorColumn: settings.showVendorColumn,
        lastUpdated: settings.lastUpdated,
      });
    } catch (error) {
      logger.error('Failed to get settings', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({ error: 'Failed to fetch settings' });
    }
  });

  // Update shop settings
  app.post('/api/settings', async (req, res) => {
    try {
      const schema = z.object({
        shopDomain: z.string(),
        showVendorColumn: z.boolean().optional(),
      });

      const { shopDomain, showVendorColumn } = schema.parse(req.body);

      // Validate shop access
      const hasAccess = await authService.validateShopAccess(shopDomain);
      if (!hasAccess) {
        return res.status(401).json({ error: 'Shop not authenticated' });
      }

      const updatedSettings = await storage.updateShopSettings(shopDomain, {
        showVendorColumn,
      });

      res.json({
        shopDomain: updatedSettings.shopDomain,
        showVendorColumn: updatedSettings.showVendorColumn,
        lastUpdated: updatedSettings.lastUpdated,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Invalid request data',
          details: error.errors,
        });
      }

      logger.error('Failed to update settings', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  // Get system statistics
  app.get('/api/stats', async (req, res) => {
    try {
      const stats = await storage.getSystemStats();
      const apiStats = await storage.getApiLogStats(24);
      
      res.json({
        ...stats,
        apiEndpoints: apiStats,
      });
    } catch (error) {
      logger.error('Failed to get system stats', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({ error: 'Failed to fetch system statistics' });
    }
  });

  // Get API logs
  app.get('/api/logs', async (req, res) => {
    try {
      const { shopDomain, limit } = req.query;
      
      const logs = await storage.getApiLogs(
        shopDomain as string,
        limit ? parseInt(limit as string) : undefined
      );

      res.json({ logs });
    } catch (error) {
      logger.error('Failed to get API logs', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({ error: 'Failed to fetch API logs' });
    }
  });

  // OAuth callback endpoint (for Shopify app installation)
  app.get('/api/auth/callback', async (req, res) => {
    try {
      const { code, shop, state } = req.query;
      
      if (!code || !shop) {
        return res.status(400).json({ error: 'Missing required parameters' });
      }

      // In production, validate state parameter for CSRF protection
      
      const clientId = process.env.SHOPIFY_CLIENT_ID || 'your_client_id';
      const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || 'your_client_secret';
      
      const tokenData = await authService.exchangeCodeForToken(
        shop as string,
        code as string,
        clientId,
        clientSecret
      );

      await authService.storeShopCredentials(
        shop as string,
        tokenData.access_token,
        tokenData.scope
      );

      logger.authSuccess(shop as string, tokenData.scope);

      res.redirect(`/dashboard?shop=${shop}&installed=true`);
    } catch (error) {
      logger.authFailure(
        req.query.shop as string || 'unknown',
        error instanceof Error ? error.message : 'Unknown error'
      );
      res.status(400).json({ error: 'Authentication failed' });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
