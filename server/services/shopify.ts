import { logger } from '../utils/logger';

export interface ShopifyProduct {
  id: string;
  title: string;
  vendor: string;
  status: string;
  totalInventory: number;
  productType: string;
}

export interface ShopifyProductsResponse {
  products: {
    edges: Array<{
      cursor: string;
      node: ShopifyProduct;
    }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string;
    };
  };
}

export interface ShopifyBulkUpdateResponse {
  productBulkUpdate: {
    userErrors: Array<{
      field: string;
      message: string;
    }>;
  };
}

export class ShopifyService {
  private baseUrl: string;
  private accessToken: string;

  constructor(shopDomain: string, accessToken: string) {
    this.baseUrl = `https://${shopDomain}/admin/api/2023-10/graphql.json`;
    this.accessToken = accessToken;
  }

  private async makeGraphQLRequest<T>(query: string, variables?: any): Promise<T> {
    const startTime = Date.now();
    
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': this.accessToken,
        },
        body: JSON.stringify({
          query,
          variables,
        }),
      });

      const responseTime = Date.now() - startTime;
      
      if (!response.ok) {
        logger.error('Shopify API error', {
          status: response.status,
          statusText: response.statusText,
          responseTime,
        });
        throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      if (data.errors) {
        logger.error('Shopify GraphQL errors', { errors: data.errors, responseTime });
        throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
      }

      logger.info('Shopify API success', {
        endpoint: 'graphql',
        responseTime,
      });

      return data.data as T;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      logger.error('Shopify API request failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        responseTime,
      });
      throw error;
    }
  }

  async getProducts(first = 50, after?: string, query?: string): Promise<ShopifyProductsResponse> {
    const graphqlQuery = `
      query GetProducts($first: Int!, $after: String, $query: String) {
        products(first: $first, after: $after, query: $query) {
          edges {
            cursor
            node {
              id
              title
              vendor
              status
              totalInventory
              productType
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    return this.makeGraphQLRequest<ShopifyProductsResponse>(graphqlQuery, {
      first,
      after,
      query,
    });
  }

  async bulkUpdateVendor(productIds: string[], vendor: string): Promise<ShopifyBulkUpdateResponse> {
    const mutation = `
      mutation BulkUpdateVendor($productIds: [ID!]!, $vendor: String!) {
        productBulkUpdate(productIds: $productIds, vendor: $vendor) {
          userErrors {
            field
            message
          }
        }
      }
    `;

    return this.makeGraphQLRequest<ShopifyBulkUpdateResponse>(mutation, {
      productIds,
      vendor,
    });
  }

  async getAllVendors(): Promise<string[]> {
    const vendors = new Set<string>();
    let hasNextPage = true;
    let cursor: string | undefined;

    while (hasNextPage) {
      const response = await this.getProducts(250, cursor);
      
      response.products.edges.forEach(edge => {
        if (edge.node.vendor) {
          vendors.add(edge.node.vendor);
        }
      });

      hasNextPage = response.products.pageInfo.hasNextPage;
      cursor = response.products.pageInfo.endCursor;
    }

    return Array.from(vendors).sort();
  }

  async getProductsByVendor(vendor: string): Promise<ShopifyProduct[]> {
    const products: ShopifyProduct[] = [];
    let hasNextPage = true;
    let cursor: string | undefined;

    while (hasNextPage) {
      const response = await this.getProducts(250, cursor, `vendor:"${vendor}"`);
      
      response.products.edges.forEach(edge => {
        products.push(edge.node);
      });

      hasNextPage = response.products.pageInfo.hasNextPage;
      cursor = response.products.pageInfo.endCursor;
    }

    return products;
  }

  async validateConnection(): Promise<boolean> {
    try {
      await this.getProducts(1);
      return true;
    } catch (error) {
      logger.error('Shopify connection validation failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }
}

export function createShopifyService(shopDomain: string, accessToken: string): ShopifyService {
  return new ShopifyService(shopDomain, accessToken);
}
