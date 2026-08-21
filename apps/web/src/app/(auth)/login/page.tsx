'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff, Loader2, Cpu, Zap } from 'lucide-react'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.message || 'Invalid email or password')
        return
      }

      // Store token
      localStorage.setItem('access_token', data.accessToken)
      localStorage.setItem('refresh_token', data.refreshToken)
      localStorage.setItem('user', JSON.stringify(data.user))

      router.push('/dashboard')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="animate-fade-in">
      {/* Logo & Branding */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-teal-500/10 border border-teal-500/20 mb-4 glow-teal">
          <span className="text-2xl font-black gradient-text-teal">LD</span>
        </div>
        <h1 className="text-2xl font-bold text-foreground">LD ERP Solution</h1>
        <p className="text-muted-foreground text-sm mt-1">AI-Powered Garment ERP</p>
      </div>

      {/* Login Card */}
      <div className="glass-card p-8">
        <div className="mb-6">
          <h2 className="text-xl font-semibold text-foreground">Welcome back</h2>
          <p className="text-muted-foreground text-sm mt-1">Sign in to your workspace</p>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm animate-fade-in">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label htmlFor="email" className="form-label">
              Email address
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="form-input"
              placeholder="you@ldcottonmills.com"
              required
              autoComplete="email"
            />
          </div>

          <div>
            <label htmlFor="password" className="form-label">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="form-input pr-10"
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <input type="checkbox" className="rounded border-border" />
              Remember me
            </label>
            <button
              type="button"
              className="text-sm text-teal-400 hover:text-teal-300 transition-colors"
            >
              Forgot password?
            </button>
          </div>

          <button
            id="login-btn"
            type="submit"
            disabled={isLoading}
            className="btn-primary w-full justify-center py-2.5 text-base"
          >
            {isLoading ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                Signing in...
              </>
            ) : (
              'Sign in'
            )}
          </button>
        </form>

        {/* AI Features Hint */}
        <div className="mt-6 pt-5 border-t border-border">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Cpu size={14} className="text-teal-400" />
            <span>AI Assistant available after login</span>
            <span className="ml-auto flex items-center gap-1 text-teal-400">
              <Zap size={12} />
              Powered by Gemini
            </span>
          </div>
        </div>
      </div>

      {/* Footer */}
      <p className="text-center text-xs text-muted-foreground mt-6">
        LD ERP Solution v1.0 &bull; © 2025 LD Cotton Mills
      </p>
    </div>
  )
}
