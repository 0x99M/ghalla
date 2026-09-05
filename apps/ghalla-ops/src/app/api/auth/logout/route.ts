import { isSecureRequest } from '../../../../lib/auth/guard';
import { SESSION_COOKIE } from '../../../../lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const secure = isSecureRequest(request.headers, request.url);
  const response = new Response(null, {
    status: 303,
    headers: { Location: new URL('/login', request.url).toString() },
  });
  // Max-Age=0 rather than an absent cookie: the browser has to be told to drop
  // the one it holds, and a response that simply omits it leaves it in place.
  response.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
  );
  return response;
}
