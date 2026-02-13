import { NextRequest, NextResponse } from 'next/server';

/**
 * Desktop Session API
 *
 * 参考：Cap/apps/web/app/api/desktop/[...route]/session.ts
 *
 * 流程：
 * 1. Desktop 打开这个 URL（带 port 或 platform 参数）
 * 2. 直接重定向到 /login?next=当前URL
 * 3. 用户登录后，login 页面会重定向到 Desktop 回调
 *
 * 注意：Web 端不做任何 SID 缓存，每次都要重新登录
 */
export async function GET(request: NextRequest) {
  // Build current URL for next parameter
  const currentUrl = request.nextUrl.toString();

  // Always redirect to login page - no caching, always require fresh login
  const loginUrl = new URL('/login', request.nextUrl.origin);
  loginUrl.searchParams.set('next', currentUrl);
  return NextResponse.redirect(loginUrl);
}
