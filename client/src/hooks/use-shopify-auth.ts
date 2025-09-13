import { useState, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface ShopAuthStatus {
  isAuthenticated: boolean;
  shopDomain?: string;
  scope?: string;
}

export function useShopifyAuth() {
  const [currentShop, setCurrentShop] = useState<string>("");

  const validateShopMutation = useMutation({
    mutationFn: async (shopDomain: string) => {
      const response = await apiRequest("GET", `/api/settings?shopDomain=${shopDomain}`);
      return response.json();
    },
  });

  const generateAuthUrlMutation = useMutation({
    mutationFn: async (shopDomain: string) => {
      // This would typically call your backend to generate the OAuth URL
      const clientId = import.meta.env.VITE_SHOPIFY_CLIENT_ID || 'your_client_id';
      const redirectUri = `${window.location.origin}/api/auth/callback`;
      const scopes = ['read_products', 'write_products'];
      
      const params = new URLSearchParams({
        client_id: clientId,
        scope: scopes.join(','),
        redirect_uri: redirectUri,
        state: crypto.getRandomValues(new Uint32Array(1))[0].toString(16),
      });

      return `https://${shopDomain}/admin/oauth/authorize?${params.toString()}`;
    },
  });

  const checkAuthStatus = useCallback(async (shopDomain: string): Promise<ShopAuthStatus> => {
    try {
      await validateShopMutation.mutateAsync(shopDomain);
      return {
        isAuthenticated: true,
        shopDomain,
      };
    } catch (error) {
      return {
        isAuthenticated: false,
        shopDomain,
      };
    }
  }, [validateShopMutation]);

  const initiateAuth = useCallback(async (shopDomain: string) => {
    try {
      const authUrl = await generateAuthUrlMutation.mutateAsync(shopDomain);
      window.location.href = authUrl;
    } catch (error) {
      throw new Error('Failed to initiate authentication');
    }
  }, [generateAuthUrlMutation]);

  return {
    currentShop,
    setCurrentShop,
    checkAuthStatus,
    initiateAuth,
    isValidating: validateShopMutation.isPending,
    isGeneratingAuth: generateAuthUrlMutation.isPending,
  };
}
