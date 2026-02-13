// User info type
export interface UserInfo {
  uid: string;
  name: string;
  email?: string;
  icon: string;
  vip: number;
}

// Login auth type (from SceneSpeak)
export enum LoginAuthType {
  SendCode = 1,       // 发送验证码
  Google = 3,         // Google AccessToken
  VerifyCode = 8,     // 验证码登录
}

// Login response type
export interface LoginResponse {
  authType: number;
  sid: string;
  pToken: string;
  message: string;
  account: {
    uid: string;
    type: number;
    email: string;
    googleId?: string;
    createdTime: number;
    newAccount: boolean;
  };
  user: UserInfo & {
    status: number;
    extra?: unknown;
    createdTime: number;
    customerId?: string;
  };
}
