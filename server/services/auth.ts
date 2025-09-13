import crypto from 'crypto';
import { storage } from '../storage';
import { logger } from '../utils/logger';
import type { ShopSettings, InsertShopSettings } from '@shared/schema';

export class AuthService {
  private readonly ENCRYPTION_KEY = process.env.SESSION_SECRET || 'default_secret_key_32_characters';
  private readonly ALGORITHM = 'aes-256-gcm';

  encryptToken(token: string): { encrypted: string; iv: string; tag: string } {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipher(this.ALGORITHM, this.ENCRYPTION_KEY);
    
    let encrypted = cipher.update(token, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag();
    
    return {
      encrypted,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
    };
  }

  decryptToken(encryptedData: { encrypted: string; iv: string; tag: string }): string {
    const decipher = crypto.createDecipher(this.ALGORITHM, this.ENCRYPTION_KEY);
    decipher.setAuthTag(Buffer.from(encryptedData.tag, 'hex'));
    
    let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  async storeShopCredentials(
    shopDomain: string,
    accessToken: string,
    scope?: string
  ): Promise<ShopSettings> {
    try {
      // Encrypt the access token
      const encryptionResult = this.encryptToken(accessToken);
      const encryptedToken = JSON.stringify(encryptionResult);

      // Check if shop already exists
      const existingShop = await storage.getShopSettings(shopDomain);

      if (existingShop) {
        // Update existing shop
        return storage.updateShopSettings(shopDomain, {
          accessToken, // Store plain text for development - in production, only store encrypted
          encryptedToken,
          tokenScope: scope,
        });
      } else {
        // Create new shop
        const shopData: InsertShopSettings = {
          shopDomain,
          accessToken, // Store plain text for development
          encryptedToken,
          tokenScope: scope,
          showVendorColumn: true,
        };

        return storage.createShopSettings(shopData);
      }
    } catch (error) {
      logger.error('Failed to store shop credentials', {
        shopDomain,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  async getShopCredentials(shopDomain: string): Promise<{
    accessToken: string;
    scope?: string;
  } | null> {
    try {
      const shopSettings = await storage.getShopSettings(shopDomain);
      
      if (!shopSettings) {
        return null;
      }

      // For development, return plain text token
      if (shopSettings.accessToken) {
        return {
          accessToken: shopSettings.accessToken,
          scope: shopSettings.tokenScope || undefined,
        };
      }

      // In production, decrypt the token
      if (shopSettings.encryptedToken) {
        const encryptedData = JSON.parse(shopSettings.encryptedToken);
        const accessToken = this.decryptToken(encryptedData);
        
        return {
          accessToken,
          scope: shopSettings.tokenScope || undefined,
        };
      }

      return null;
    } catch (error) {
      logger.error('Failed to retrieve shop credentials', {
        shopDomain,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  async validateShopAccess(shopDomain: string): Promise<boolean> {
    try {
      const credentials = await this.getShopCredentials(shopDomain);
      return credentials !== null;
    } catch (error) {
      logger.error('Failed to validate shop access', {
        shopDomain,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  async revokeShopAccess(shopDomain: string): Promise<void> {
    try {
      await storage.updateShopSettings(shopDomain, {
        accessToken: null,
        encryptedToken: null,
        tokenScope: null,
      });

      logger.info('Shop access revoked', { shopDomain });
    } catch (error) {
      logger.error('Failed to revoke shop access', {
        shopDomain,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  generateShopifyAuthUrl(shopDomain: string, clientId: string, redirectUri: string, scopes: string[]): string {
    const params = new URLSearchParams({
      client_id: clientId,
      scope: scopes.join(','),
      redirect_uri: redirectUri,
      state: crypto.randomBytes(16).toString('hex'),
    });

    return `https://${shopDomain}/admin/oauth/authorize?${params.toString()}`;
  }

  async exchangeCodeForToken(
    shopDomain: string,
    code: string,
    clientId: string,
    clientSecret: string
  ): Promise<{ access_token: string; scope: string }> {
    try {
      const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
        }),
      });

      if (!response.ok) {
        throw new Error(`OAuth token exchange failed: ${response.status} ${response.statusText}`);
      }

      const tokenData = await response.json();
      
      logger.info('OAuth token exchange successful', {
        shopDomain,
        scope: tokenData.scope,
      });

      return tokenData;
    } catch (error) {
      logger.error('OAuth token exchange failed', {
        shopDomain,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }
}

export const authService = new AuthService();
