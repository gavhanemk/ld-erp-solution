'use client'

import { useEffect, useRef, useState } from 'react'
import { Camera, CameraOff, ScanLine } from 'lucide-react'

/**
 * Where a code comes in: a handheld scanner, the phone's camera, or a person
 * typing the number printed under the QR.
 *
 * A handheld scanner is a keyboard: it types the code into whichever box has
 * the cursor and presses Enter. So the box keeps the cursor between scans,
 * and a scan is simply what arrives followed by Enter.
 *
 * The camera stops after each code it reads. One scan is one package; a
 * camera left running reads the same sticker three times while it is being
 * lowered.
 */
export function Scanner({
  onCode,
  busy = false,
  placeholder = 'Scan a sticker, or type its number',
  autoFocus = true,
  onType,
  suggestions,
}: {
  onCode: (code: string) => void
  busy?: boolean
  placeholder?: string
  autoFocus?: boolean
  /** What is being typed, as it is typed — for suggestions under the box. */
  onType?: (text: string) => void
  /** Shown just under the box, over what follows: suggestions to pick from. */
  suggestions?: React.ReactNode
}) {
  const [typed, setTyped] = useState('')
  const [camera, setCamera] = useState(false)
  const [camError, setCamError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // A scanner gun at a desk types into the box, so it keeps the cursor. On a
  // phone the cursor would open the keyboard over the screen; the camera is
  // what is used there.
  useEffect(() => {
    const touch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
    if (autoFocus && !busy && !touch) inputRef.current?.focus()
  }, [autoFocus, busy])

  useEffect(() => {
    if (!camera) return
    let cancelled = false
    let stop: (() => void) | undefined
    ;(async () => {
      // Browsers only lend the camera to a secure page: https, or localhost.
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setCamError('The camera only works when the ERP is opened over https. Use a handheld scanner, or type the number.')
        setCamera(false)
        return
      }
      const { BrowserMultiFormatReader } = await import('@zxing/browser')
      if (cancelled || !videoRef.current) return
      const reader = new BrowserMultiFormatReader()
      // A code can be read before the camera's stop handle has come back, so
      // the handle is looked up when needed rather than held from the start.
      const controls = await reader.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' } } },
        videoRef.current,
        (result) => {
          if (!result || cancelled) return
          cancelled = true
          navigator.vibrate?.(80)
          stop?.()
          setCamera(false)
          onCode(result.getText())
        },
      )
      stop = () => controls.stop()
      if (cancelled) controls.stop()
    })().catch((err: unknown) => {
      const name = (err as { name?: string })?.name
      setCamError(
        name === 'NotAllowedError'
          ? 'The camera was not allowed. Allow it in the browser’s site settings, then try again.'
          : name === 'NotFoundError'
            ? 'No camera was found on this device.'
            : 'The camera could not be started.',
      )
      setCamera(false)
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [camera, onCode])

  const submit = () => {
    const code = typed.trim()
    if (!code || busy) return
    setTyped('')
    onType?.('')
    onCode(code)
  }

  return (
    <div className="space-y-3">
      <div className="relative flex flex-col gap-2 sm:flex-row">
        <div className="flex h-14 flex-1 items-center gap-3 rounded-xl border-2 border-primary/40 bg-secondary px-4 focus-within:border-primary">
          <ScanLine size={22} className="shrink-0 text-primary" aria-hidden />
          <input
            ref={inputRef}
            className="min-w-0 flex-1 border-0 bg-transparent text-lg font-medium text-foreground outline-none placeholder:text-muted-foreground"
            placeholder={placeholder}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value)
              onType?.(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            disabled={busy}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-label="Package code"
          />
          {typed && (
            <button type="button" className="btn-primary h-10" onClick={submit} disabled={busy}>
              Find
            </button>
          )}
        </div>
        <button
          type="button"
          className={`h-14 justify-center text-base ${camera ? 'btn-secondary' : 'btn-primary'} sm:w-48`}
          onClick={() => {
            setCamError(null)
            setCamera((c) => !c)
          }}
          disabled={busy}
        >
          {camera ? <CameraOff size={20} /> : <Camera size={20} />}
          {camera ? 'Stop camera' : 'Use camera'}
        </button>
        {suggestions}
      </div>
      {camError && <p className="text-sm text-red-400">{camError}</p>}
      {camera && (
        <div className="relative mx-auto aspect-square w-full max-w-sm overflow-hidden rounded-xl bg-black">
          <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
          {/* A square to aim with. */}
          <div className="pointer-events-none absolute inset-[18%] rounded-lg border-4 border-white/80" />
          <p className="absolute inset-x-0 bottom-2 text-center text-sm font-medium text-white drop-shadow">Hold the QR inside the square</p>
        </div>
      )}
    </div>
  )
}
