// prepare-run --inputs (cli-and-sdk plan §7; bead va-p1th.5.2): local mode reads <dir>/<store>/<key> instead of Blobs
// and prepares exactly the same video/; keys that would leave the folder are refused.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fromInputs, prepare } from '../../scripts/prepare-run.js'
import { which } from '../../scripts/lib/run-tools.js'
import { RUN_MANIFEST_VERSION, sha256Hex, type RunManifest } from '../server/lib/run-manifest.js'

const ffmpeg = which('ffmpeg')
const sha = (file: string) => sha256Hex(readFileSync(file))

/** Every file under `dir`, relative path → sha256. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex')
    }
  }
  walk(dir)
  return out
}

const put = (dir: string, store: string, key: string, from: string) => {
  const to = join(dir, store, key)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}

describe('prepare-run --inputs', () => {
  it('refuses keys that leave the folder, and names a missing one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'va-inputs-'))
    const outside = mkdtempSync(join(tmpdir(), 'va-outside-'))
    writeFileSync(join(outside, 'secret'), 'no')
    mkdirSync(join(dir, 'sources', 'vid_1'), { recursive: true })
    symlinkSync(join(outside, 'secret'), join(dir, 'sources', 'vid_1', 'link'))
    const fetch = fromInputs(dir)
    const to = join(outside, 'got')
    for (const key of ['../x', 'vid_1/../../x', '/etc/passwd', 'vid_1/link'])
      await expect(fetch(key, to)).rejects.toThrow(/outside the inputs folder/)
    await expect(fetch('vid_1/runs/att_1.json', to)).rejects.toThrow(
      'download vid_1/runs/att_1.json failed: sources/vid_1/runs/att_1.json is not in the inputs folder.',
    )
  })

  it('logs each fetched key with its store, size, time and mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'va-inputs-'))
    mkdirSync(join(dir, 'media', 'm'), { recursive: true })
    writeFileSync(join(dir, 'media', 'm', 'a.png'), 'png')
    const lines: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((l: string) => void lines.push(l))
    await fromInputs(dir)('m/a.png', join(dir, 'out.png'), 'media')
    spy.mockRestore()
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      step: 'prepare.fetch',
      store: 'media',
      key: 'm/a.png',
      bytes: 3,
      mode: 'inputs',
    })
  })

  it.skipIf(!ffmpeg)(
    'a revision with a parent source, two media items and a feedback still prepares the same as from Blobs',
    async () => {
      const src = mkdtempSync(join(tmpdir(), 'va-src-'))
      mkdirSync(join(src, 'video'))
      writeFileSync(join(src, 'video', 'index.html'), '<div>v1</div>')
      writeFileSync(join(src, 'video', 'summary.json'), '{}')
      const archive = join(src, 'source.tar.gz')
      execFileSync('tar', ['-czf', archive, '-C', src, 'video'])
      writeFileSync(join(src, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
      writeFileSync(join(src, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
      const mp4 = join(src, 'parent.mp4')
      execFileSync('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=160x90:d=2',
        '-pix_fmt',
        'yuv420p',
        mp4,
      ])
      const dir = mkdtempSync(join(tmpdir(), 'va-inputs-'))
      put(dir, 'sources', 'vid_1/v1/source.tar.gz', archive)
      put(dir, 'media', 'team/med_1/logo.svg', join(src, 'logo.svg'))
      put(dir, 'media', 'team/med_2/shot.png', join(src, 'shot.png'))
      put(dir, 'videos', 'vid_1/v1/video.mp4', mp4)
      const m: RunManifest = {
        v: RUN_MANIFEST_VERSION,
        jobId: 'vid_1',
        attemptId: 'att_2',
        versionN: 2,
        kind: 'revision',
        source: { key: 'vid_1/v1/source.tar.gz', sha256: sha(archive), parentN: 1 },
        bundle: null,
        media: [
          {
            key: 'team/med_1/logo.svg',
            sha256: sha(join(src, 'logo.svg')),
            filename: 'logo.svg',
            kind: 'svg',
          },
          {
            key: 'team/med_2/shot.png',
            sha256: sha(join(src, 'shot.png')),
            filename: 'shot.png',
            kind: 'image',
          },
        ],
        feedback: {
          video: { key: 'vid_1/v1/video.mp4', sha256: sha(mp4) },
          pins: [{ commentId: 'cmt_1', timeSec: 1, x: 0.5, y: 0.5 }],
        },
      }
      const workspace = () => {
        const root = mkdtempSync(join(tmpdir(), 'va-ws-'))
        mkdirSync(join(root, 'video'))
        return root
      }
      const local = workspace()
      await prepare(m, { tmp: mkdtempSync(join(tmpdir(), 'va-tmp-')), root: local, fetch: fromInputs(dir) })
      // Blobs mode, with blobs:get standing in as a copy from the same folder.
      const blobs = workspace()
      await prepare(m, {
        tmp: mkdtempSync(join(tmpdir(), 'va-tmp-')),
        root: blobs,
        fetch: async (key, to, store = 'sources') => {
          copyFileSync(join(dir, store, key), to)
        },
      })
      const a = tree(join(local, 'video'))
      expect(a).toEqual(tree(join(blobs, 'video')))
      expect(Object.keys(a).sort()).toEqual(
        expect.arrayContaining([
          'index.html',
          'assets/media/logo.svg',
          'assets/media/shot.png',
          expect.stringMatching(/^feedback\//),
        ]),
      )
      expect(statSync(join(local, 'video', 'index.html')).size).toBeGreaterThan(0)
    },
  )
})
