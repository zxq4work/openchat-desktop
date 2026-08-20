import { create } from 'zustand'
import type { AuthStatus } from '../../shared/types/account'

interface AuthState {
  status: AuthStatus
  email: string | null
  planType: string | null
  userId: string | null
  accountId: string | null
  setStatus: (status: AuthStatus) => void
  setAccount: (email: string | null, planType: string | null, userId?: string | null, accountId?: string | null) => void
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'unknown',
  email: null,
  planType: null,
  userId: null,
  accountId: null,
  setStatus: (status) => set({ status }),
  setAccount: (email, planType, userId = null, accountId = null) => set({ email, planType, userId, accountId }),
}))