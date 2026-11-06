// Download a take's audio (owner, 2026-11-06): in the take review row and on a selected narration clip. The file as
// stored, and a smaller M4A made in this browser when it can encode AAC.
import { Button, Menu } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconDownload } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { $api } from '../api/client'
import { canCompress, compressAudio, saveBlob, takeBaseName, takeExt } from '../lib/take-download'
import { log } from '../lib/log'

export function TakeDownload(props: {
  /** The file name without its extension: `lumen-v1-take-3`. */
  base: string
  /** The stored file's extension (wav for a recorded take). */
  ext: string
  /** Loads the stored file. */
  load: () => Promise<Blob>
  disabled?: boolean
  testId?: string
}) {
  const [compress, setCompress] = useState(false)
  const [busy, setBusy] = useState<'file' | 'small' | null>(null)
  useEffect(() => {
    void canCompress().then(setCompress)
  }, [])
  const run = async (kind: 'file' | 'small') => {
    setBusy(kind)
    const t0 = Date.now()
    try {
      const blob = await props.load()
      if (kind === 'file') saveBlob(blob, `${props.base}.${props.ext}`)
      else {
        const small = await compressAudio(blob)
        if (!small) throw new Error("This browser can't make a smaller copy.")
        saveBlob(small, `${props.base}.m4a`)
        log('take.download', { kind, bytes: blob.size, smallBytes: small.size, ms: Date.now() - t0 })
        return
      }
      log('take.download', { kind, bytes: blob.size, ms: Date.now() - t0 })
    } catch (e) {
      notifications.show({
        color: 'red',
        message: e instanceof Error ? e.message : "The take didn't download.",
      })
    } finally {
      setBusy(null)
    }
  }
  const label = `Download (${props.ext.toUpperCase()})`
  if (!compress)
    return (
      <Button
        size="xs"
        variant="subtle"
        color="gray"
        leftSection={<IconDownload size={14} />}
        loading={busy === 'file'}
        disabled={props.disabled === true}
        onClick={() => void run('file')}
        data-testid={props.testId}
      >
        {label}
      </Button>
    )
  return (
    <Menu position="bottom-end">
      <Menu.Target>
        <Button
          size="xs"
          variant="subtle"
          color="gray"
          leftSection={<IconDownload size={14} />}
          loading={busy !== null}
          disabled={props.disabled === true}
          data-testid={props.testId}
        >
          Download
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={() => void run('file')} data-testid="take-download-file">
          {props.ext.toUpperCase()}, as recorded
        </Menu.Item>
        <Menu.Item onClick={() => void run('small')} data-testid="take-download-small">
          M4A, smaller
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  )
}

/** Download for a narration clip's take: its media file, named after the video, the version and the take. */
export function ClipTakeDownload(props: {
  videoId: string
  versionN: number
  mediaId: string
  take: number
}) {
  const video = $api.useQuery('get', '/api/v1/videos/{id}', { params: { path: { id: props.videoId } } })
  const media = $api.useQuery('get', '/api/v1/media/{id}', { params: { path: { id: props.mediaId } } })
  const m = media.data
  const base = takeBaseName(video.data?.title ?? 'video', props.versionN, props.take)
  return (
    <TakeDownload
      base={base}
      ext={takeExt(m?.filename, m?.mime)}
      disabled={!m?.urls}
      testId="clip-download"
      load={async () => {
        const url = m?.urls?.file
        if (!url) throw new Error("This take's file isn't available.")
        const res = await fetch(url)
        if (!res.ok) throw new Error(`The take didn't download (${res.status}).`)
        return res.blob()
      }}
    />
  )
}
