import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export function useVendors(shopDomain: string) {
  const queryClient = useQueryClient();

  const { data: vendorsData, isLoading, error } = useQuery<{ vendors: string[] }>({
    queryKey: ['/api/vendors', shopDomain],
    queryFn: async () => {
      if (!shopDomain) throw new Error('Shop domain is required');
      
      const response = await fetch(`/api/vendors?shopDomain=${shopDomain}`);
      if (!response.ok) throw new Error('Failed to fetch vendors');
      return response.json();
    },
    enabled: !!shopDomain,
  });

  const refreshVendorsMutation = useMutation({
    mutationFn: async () => {
      if (!shopDomain) throw new Error('Shop domain is required');
      
      // Invalidate cache to force refresh from Shopify
      queryClient.removeQueries({ queryKey: ['/api/vendors', shopDomain] });
      const response = await fetch(`/api/vendors?shopDomain=${shopDomain}`);
      if (!response.ok) throw new Error('Failed to refresh vendors');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/vendors'] });
    },
  });

  const exportVendorMutation = useMutation({
    mutationFn: async (params: { shopDomain: string; vendor?: string; filters?: any }) => {
      const response = await apiRequest("POST", "/api/export", params);
      return response.json();
    },
  });

  return {
    vendors: vendorsData?.vendors || [],
    isLoading,
    error,
    refreshVendors: refreshVendorsMutation.mutateAsync,
    exportVendor: exportVendorMutation.mutateAsync,
    isRefreshing: refreshVendorsMutation.isPending,
    isExporting: exportVendorMutation.isPending,
  };
}

export function useVendorExport() {
  return useMutation({
    mutationFn: async (params: { 
      shopDomain: string; 
      vendor?: string; 
      filters?: {
        status?: string;
        productType?: string;
      }
    }) => {
      const response = await apiRequest("POST", "/api/export", params);
      return response.json();
    },
  });
}
