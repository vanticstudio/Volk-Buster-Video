// Is a byte range readable from a poster bank's CPU mirror?
//
// Zero imports, so tests/poster-mirror-read.test.ts can load it under
// `node --test`'s type-stripping loader — poster-textures.ts cannot be, because
// it imports three and uses extensionless specifiers.

/**
 * True when [byteStart, byteStart + byteLen) lies inside `data`.
 *
 * THE MIRROR CAN BE NULL. In viewer mode poster-textures.ts releases the
 * high-res bank's CPU copy once the GPU owns the storage (releaseMirrorIfUnused),
 * because nothing on the public port can trigger the rebuild that re-uploads it.
 * But getFallbackPixels still read `(data as Uint8Array).length` straight off it,
 * so it threw a TypeError the moment a hovered title in the FIRST bank of a
 * two-bank catalog missed its caller's low-res cache — uncaught all the way out
 * through hero-lowres-front.ts and video-case.ts.
 *
 * Two banks happen whenever the GPU's layer limit is below the title count plus
 * churn headroom: 2,048 layers on Windows ANGLE/D3D11 (and measured on an M4 Pro)
 * against 2,238 for a 2,174-title catalog. Titles in the first bank then have a
 * negative low-res slot, skip the atlas branch, and land on the high-res read.
 *
 * Returning false sends the caller down its existing "no pixels" path — the
 * placeholder — which is right for pixels that were freed on purpose.
 */
export function mirrorRangeReadable(
  data: ArrayLike<number> | null | undefined,
  byteStart: number,
  byteLen: number,
): boolean {
  return !!data && byteStart >= 0 && byteLen >= 0 && byteStart + byteLen <= data.length;
}
