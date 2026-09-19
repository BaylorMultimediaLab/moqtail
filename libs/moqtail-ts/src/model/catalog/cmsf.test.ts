import { describe, it, expect, vi } from 'vitest'
import { CMSFCatalog } from './cmsf'

function makeCatalogPayload(track: Record<string, unknown>): ArrayBuffer {
  const json = JSON.stringify({ version: 1, tracks: [track] })
  return new TextEncoder().encode(json).buffer
}

describe('CMSFCatalog gopDurationMs', () => {
  it('parses gopDurationMs from track JSON when present', () => {
    const payload = makeCatalogPayload({
      name: 'video-720p',
      packaging: 'cmaf',
      role: 'video',
      codec: 'hev1.1.6.L120.B0',
      gopDurationMs: 2000,
    })
    const cat = CMSFCatalog.from(payload)
    expect(cat.getGopDurationMs('video-720p')).toBe(2000)
  })

  it('defaults gopDurationMs to 1000 and warns when absent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const payload = makeCatalogPayload({
      name: 'video-720p',
      packaging: 'cmaf',
      role: 'video',
      codec: 'hev1.1.6.L120.B0',
    })
    const cat = CMSFCatalog.from(payload)
    expect(cat.getGopDurationMs('video-720p')).toBe(1000)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('throws when gopDurationMs is not a number', () => {
    const payload = makeCatalogPayload({
      name: 'video-720p',
      packaging: 'cmaf',
      role: 'video',
      codec: 'hev1.1.6.L120.B0',
      gopDurationMs: 'abc',
    })
    expect(() => CMSFCatalog.from(payload)).toThrow(/gopDurationMs/)
  })

  it('defaults and warns when track is not in the catalog', () => {
    const payload = makeCatalogPayload({
      name: 'video-720p',
      packaging: 'cmaf',
      role: 'video',
      codec: 'hev1.1.6.L120.B0',
      gopDurationMs: 1000,
    })
    const cat = CMSFCatalog.from(payload)
    // Unknown track name: still defaults to 1000 with warn, so callers
    // never have to branch on undefined.
    expect(cat.getGopDurationMs('nonexistent')).toBe(1000)
  })
})
