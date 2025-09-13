import { createShopifyService } from './shopify';
import { storage } from '../storage';
import { logger } from '../utils/logger';
import jwt from 'jsonwebtoken';
import type { ShopifyProduct } from './shopify';

export interface ExportOptions {
  shopDomain: string;
  vendor?: string;
  filters?: {
    status?: string;
    productType?: string;
  };
}

export class CSVExportService {
  private readonly JWT_SECRET = process.env.SESSION_SECRET || 'default_secret';
  private readonly EXPORT_EXPIRY = '1h'; // 1 hour expiry for signed URLs

  async exportProducts(options: ExportOptions): Promise<string> {
    try {
      logger.info('Starting CSV export', options);

      // Get shop settings
      const shopSettings = await storage.getShopSettings(options.shopDomain);
      if (!shopSettings?.accessToken) {
        throw new Error('Shop access token not found');
      }

      const shopifyService = createShopifyService(options.shopDomain, shopSettings.accessToken);

      let products: ShopifyProduct[] = [];

      if (options.vendor) {
        // Get products by specific vendor
        products = await shopifyService.getProductsByVendor(options.vendor);
      } else {
        // Get all products
        let hasNextPage = true;
        let cursor: string | undefined;

        while (hasNextPage) {
          const response = await shopifyService.getProducts(250, cursor);
          
          response.products.edges.forEach(edge => {
            products.push(edge.node);
          });

          hasNextPage = response.products.pageInfo.hasNextPage;
          cursor = response.products.pageInfo.endCursor;
        }
      }

      // Apply additional filters
      if (options.filters) {
        products = products.filter(product => {
          if (options.filters?.status && product.status !== options.filters.status) {
            return false;
          }
          if (options.filters?.productType && product.productType !== options.filters.productType) {
            return false;
          }
          return true;
        });
      }

      // Generate CSV content
      const csvContent = this.generateCSV(products);

      // Create signed URL for download
      const token = jwt.sign({
        shopDomain: options.shopDomain,
        exportDate: new Date().toISOString(),
        filters: options.filters || {},
        vendor: options.vendor,
      }, this.JWT_SECRET, { expiresIn: this.EXPORT_EXPIRY });

      // Store CSV content temporarily (in production, use cloud storage)
      const exportId = this.generateExportId();
      await this.storeCsvContent(exportId, csvContent);

      const signedUrl = `/api/export/download/${exportId}?token=${token}`;

      logger.info('CSV export completed', {
        shopDomain: options.shopDomain,
        productCount: products.length,
        exportId,
      });

      return signedUrl;

    } catch (error) {
      logger.error('CSV export failed', {
        shopDomain: options.shopDomain,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  private generateCSV(products: ShopifyProduct[]): string {
    const headers = [
      'Product ID',
      'Title',
      'Vendor',
      'Status',
      'Product Type',
      'Total Inventory'
    ];

    const rows = products.map(product => [
      product.id,
      `"${product.title.replace(/"/g, '""')}"`, // Escape quotes
      `"${product.vendor.replace(/"/g, '""')}"`,
      product.status,
      `"${product.productType.replace(/"/g, '""')}"`,
      product.totalInventory.toString()
    ]);

    return [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
  }

  private generateExportId(): string {
    return `export_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private csvStorage = new Map<string, string>();

  private async storeCsvContent(exportId: string, content: string): Promise<void> {
    // In production, this should use cloud storage (S3, GCS, etc.)
    this.csvStorage.set(exportId, content);
    
    // Clean up after 2 hours
    setTimeout(() => {
      this.csvStorage.delete(exportId);
    }, 2 * 60 * 60 * 1000);
  }

  async getCsvContent(exportId: string): Promise<string | undefined> {
    return this.csvStorage.get(exportId);
  }

  verifyExportToken(token: string): any {
    try {
      return jwt.verify(token, this.JWT_SECRET);
    } catch (error) {
      logger.warn('Invalid export token', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw new Error('Invalid or expired export token');
    }
  }

  async exportByVendor(shopDomain: string, vendor: string): Promise<string> {
    return this.exportProducts({
      shopDomain,
      vendor,
    });
  }

  async exportAll(shopDomain: string, filters?: ExportOptions['filters']): Promise<string> {
    return this.exportProducts({
      shopDomain,
      filters,
    });
  }
}

export const csvExportService = new CSVExportService();
