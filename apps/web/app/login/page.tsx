'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { useGoogleLogin } from '@react-oauth/google'
import { Button } from '@multica/ui/components/ui/button'
import { Input } from '@multica/ui/components/ui/input'
import { Label } from '@multica/ui/components/ui/label'
import { MulticaIcon } from '@multica/ui/components/multica-icon'
import { LoginAuthType, UserInfo } from '@/lib/interface'
import { userLogin } from '@/service/user'

type LoginStep = 'email' | 'code'

function GoogleIcon() {
  return (
    <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  )
}

export default function LoginPage() {
  const searchParams = useSearchParams()
  const next = searchParams.get('next')

  // Form state
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<LoginStep>('email')

  // Loading state
  const [isSendingCode, setIsSendingCode] = useState(false)
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Countdown state
  const [countdown, setCountdown] = useState(0)

  // Google login
  const googleLogin = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      setError(null)
      setIsLoggingIn(true)
      try {
        const res = await userLogin({
          authType: LoginAuthType.Google,
          googleToken: tokenResponse.access_token,
        })

        const { sid, user, account } = res

        if (!sid) {
          throw new Error('No session ID returned')
        }

        handleLoginSuccess(sid, {
          ...user,
          email: account?.email,
        })
      } catch (err) {
        setError('Google login failed. Please try again.')
        console.error(err)
      } finally {
        setIsLoggingIn(false)
      }
    },
    onError: () => {
      setError('Google login failed. Please try again.')
    },
  })

  // Countdown timer
  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [countdown])

  // Handle login success
  const handleLoginSuccess = (sid: string, user: UserInfo) => {
    if (next) {
      // Desktop flow - parse next URL to get port, then redirect directly to callback
      try {
        const nextUrl = new URL(next, window.location.origin)
        const port = nextUrl.searchParams.get('port')
        const platform = nextUrl.searchParams.get('platform') || 'web'

        const params = new URLSearchParams({
          sid,
          user: JSON.stringify(user),
        })

        if (platform === 'web' && port) {
          // Dev mode: redirect to local server
          window.location.href = `http://127.0.0.1:${port}/callback?${params}`
        } else {
          // Production mode: redirect to deep link
          window.location.href = `multica://auth?${params}`
        }
      } catch {
        // Fallback: just go to next URL
        window.location.href = next
      }
    } else {
      // No next parameter - normal web login, go to home
      window.location.href = '/'
    }
  }

  // Send verification code
  const handleSendCode = async () => {
    if (!email || !email.includes('@')) {
      setError('Please enter a valid email address')
      return
    }

    setError(null)
    setIsSendingCode(true)

    try {
      await userLogin({
        authType: LoginAuthType.SendCode,
        email,
      })
      setStep('code')
      setCountdown(60)
    } catch (err) {
      setError('Failed to send verification code')
      console.error(err)
    } finally {
      setIsSendingCode(false)
    }
  }

  // Verify code and login
  const handleLogin = async () => {
    if (!code || code.length < 4) {
      setError('Please enter the verification code')
      return
    }

    setError(null)
    setIsLoggingIn(true)

    try {
      const res = await userLogin({
        authType: LoginAuthType.VerifyCode,
        email,
        verificationCode: code,
      })

      const { sid, user, account } = res

      if (!sid) {
        throw new Error('No session ID returned')
      }

      handleLoginSuccess(sid, {
        ...user,
        email: account?.email || email,
      })
    } catch (err) {
      setError('Invalid or expired verification code')
      console.error(err)
    } finally {
      setIsLoggingIn(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-8">
      <div className="w-full max-w-sm space-y-6">
        {/* Logo and Header */}
        <div className="flex flex-col items-center text-center space-y-4">
          <div className="flex items-center gap-2">
            <MulticaIcon bordered noSpin size="md" />
            <span className="text-base font-brand">Multica</span>
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Enter your email to continue
            </p>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Login form */}
        <div className="space-y-4">
          {/* Email input */}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={step === 'code'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && step === 'email') {
                  handleSendCode()
                }
              }}
            />
          </div>

          {/* Verification code input (shown in step 2) */}
          {step === 'code' && (
            <div className="space-y-2">
              <Label htmlFor="code">Verification Code</Label>
              <div className="flex gap-2">
                <Input
                  id="code"
                  type="text"
                  placeholder="Enter code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  maxLength={6}
                  className="font-mono tracking-widest"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleLogin()
                    }
                  }}
                />
                <Button
                  variant="outline"
                  onClick={handleSendCode}
                  disabled={countdown > 0 || isSendingCode}
                  className="shrink-0 tabular-nums"
                >
                  {countdown > 0 ? `${countdown}s` : 'Resend'}
                </Button>
              </div>
            </div>
          )}

          {/* Action buttons */}
          {step === 'email' ? (
            <Button
              onClick={handleSendCode}
              disabled={isSendingCode || !email}
              className="w-full"
            >
              {isSendingCode ? 'Sending...' : 'Continue'}
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              <Button
                onClick={handleLogin}
                disabled={isLoggingIn || !code}
                className="w-full"
              >
                {isLoggingIn ? 'Signing in...' : 'Sign In'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setStep('email')
                  setCode('')
                  setError(null)
                }}
                className="w-full text-muted-foreground"
                size="sm"
              >
                Use a different email
              </Button>
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-background px-2 text-muted-foreground">or</span>
          </div>
        </div>

        {/* Google Login */}
        <Button
          onClick={() => googleLogin()}
          variant="outline"
          className="w-full"
          disabled={isLoggingIn}
        >
          <GoogleIcon />
          Continue with Google
        </Button>
      </div>
    </div>
  )
}
