import type { LoginResponse } from '@/lib/interface';
import { post } from './request';

// User login
export const userLogin = async (params: {
  authType: number;
  googleToken?: string;
  email?: string;
  verificationCode?: string;
}) => {
  return post<LoginResponse>('/api/v1/auth/login', params);
};
