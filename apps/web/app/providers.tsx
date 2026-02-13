'use client'

import { GoogleOAuthProvider } from '@react-oauth/google'

// Google OAuth Client ID
// TODO: Move to environment variable
const GOOGLE_CLIENT_ID = '69015293368-pg96qdahu57g8nb0oi1abv2j3qbqrshq.apps.googleusercontent.com'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      {children}
    </GoogleOAuthProvider>
  )
}
