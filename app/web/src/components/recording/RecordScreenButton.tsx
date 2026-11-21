// New video's "Record screen" button, beside Add media: record the screen without leaving the page. When recording
// stops, its setup (play, trim, crop, hide, privacy) opens in the same dialog, on the file still on this device.
// "Add to video" applies the trim, crop and boxes to the file here (lib/recording-bake), uploads that edited clip, and
// puts it on the form like a picked media item: the library never gets the unedited recording. Create video then
// sends it as the request's `recording`. The same parts as /new/demo: RecordScreen, then DemoSetup with only the
// recording's own settings.
import { Alert, Button, Card, Loader, Modal, Progress, Stack, Text } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { IconPlayerRecordFilled } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { useAuth } from '../../auth'
import type { AttachedRecording } from '../../lib/demo-setup'
import { bakeEdits, bakeRecording, hasEdits } from '../../lib/recording-bake'
import { ConvertError } from '../../lib/recording-convert'
import { uploadRecording } from '../../lib/recording-upload'
import { UploadError } from '../../lib/upload'
import { DemoSetup, type SetupMedia } from './DemoSetup'
import { RecordScreen } from './RecordScreen'

/** A recording that's still a file on this device, as setup needs it. */
interface Local {
  file: File
  media: SetupMedia
}

/** The file's size and length, read by a <video> (a recording made here is always playable here). */
function probe(file: File): Promise<Local> {
  const url = URL.createObjectURL(file)
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    v.onloadedmetadata = () => {
      resolve({
        file,
        media: {
          id: 'local',
          filename: file.name,
          title: null,
          width: v.videoWidth,
          height: v.videoHeight,
          durationSec: Number.isFinite(v.duration) ? v.duration : 0,
          hasTrace: false,
          urls: { original: url, poster: null },
        },
      })
    }
    v.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("The recording couldn't be read."))
    }
    v.src = url
  })
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`

type Busy = { label: string; pct: number } | null

export function RecordScreenButton(props: {
  onAttach: (r: AttachedRecording) => void
  /** The form's shape (for setup's note about small recordings). */
  aspect?: '16:9' | '9:16' | '1:1' | '4:5'
  disabled?: boolean
}) {
  const auth = useAuth()
  const [open, setOpen] = useState(false)
  const [local, setLocal] = useState<Local | null>(null)
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const phone = useMediaQuery('(max-width: 48em)')
  const url = local?.media.urls?.original
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url)
    },
    [url],
  )
  const close = () => {
    setOpen(false)
    setLocal(null)
    setBusy(null)
    setError(null)
  }

  /** Applies the edits to the file, uploads the result, and hands it to the form. */
  const add = async (l: Local, r: AttachedRecording) => {
    setError(null)
    try {
      const edits = bakeEdits(r.input, { width: l.media.width ?? 0, height: l.media.height ?? 0 })
      let file = l.file
      if (hasEdits(edits)) {
        setBusy({ label: 'Applying your edits…', pct: 0 })
        file = await bakeRecording(l.file, edits, {
          onProgress: (p) => {
            setBusy({ label: 'Applying your edits…', pct: p * 100 })
          },
        })
      }
      setBusy({ label: 'Reading the file…', pct: 0 })
      const id = await uploadRecording(file, {
        ...(auth.user?.id ? { userId: auth.user.id } : {}),
        onProgress: (p) => {
          setBusy({
            label:
              p.phase === 'hashing'
                ? 'Reading the file…'
                : p.phase === 'checking'
                  ? 'Checking the recording…'
                  : `Uploading ${mb(p.sent)} of ${mb(p.total)}…`,
            pct: (p.sent / Math.max(1, p.total)) * 100,
          })
        },
      })
      // The trim, crop and boxes are in the file now: the request carries only what the run still has to do.
      props.onAttach({
        ...r,
        input: {
          mediaId: id,
          ...(r.input.privacy ? { privacy: true } : {}),
          ...(r.input.hideStrings?.length ? { hideStrings: r.input.hideStrings } : {}),
        },
      })
      close()
    } catch (e) {
      setBusy(null)
      setError(
        e instanceof ConvertError && e.unsupported
          ? "This browser can't apply edits to a recording. Nothing was uploaded; remove the trim, crop and boxes to add it as it is."
          : e instanceof UploadError || e instanceof ConvertError
            ? `${e.message} Nothing was added.`
            : "The recording couldn't be added.",
      )
    }
  }

  return (
    <>
      <Button
        size="compact-sm"
        variant="default"
        leftSection={<IconPlayerRecordFilled size={14} color="var(--mantine-color-red-6)" />}
        disabled={props.disabled === true}
        onClick={() => {
          setOpen(true)
        }}
      >
        Record screen
      </Button>
      {open ? (
        <Modal
          opened
          onClose={close}
          title={local ? 'Set up your recording' : 'Record your screen'}
          size={local ? 960 : 'lg'}
          padding={phone ? 'md' : 'xl'}
          fullScreen={phone}
          // A stray click outside shouldn't throw a recording away; the close button and Escape still close it.
          closeOnClickOutside={false}
          closeOnEscape={!busy}
          withCloseButton={!busy}
          closeButtonProps={{ 'aria-label': 'Close' }}
          centered={!local}
        >
          {!local ? (
            reading ? (
              <Loader size="sm" aria-label="Opening the recording" />
            ) : (
              <Stack gap="sm">
                {error ? (
                  <Alert color="red" role="alert">
                    {error}
                  </Alert>
                ) : null}
                <RecordScreen
                  onCancel={close}
                  onRecorded={(file) => {
                    setReading(true)
                    setError(null)
                    void probe(file)
                      .then(setLocal)
                      .catch((e: unknown) => {
                        setError(e instanceof Error ? e.message : "The recording couldn't be read.")
                      })
                      .finally(() => {
                        setReading(false)
                      })
                  }}
                />
              </Stack>
            )
          ) : (
            <Stack gap="md">
              {busy ? (
                <Card withBorder radius="lg" p="lg" aria-busy="true">
                  <Stack gap="xs">
                    <Text size="sm" data-testid="recording-progress">
                      {busy.label}
                    </Text>
                    <Progress value={busy.pct} aria-label={busy.label} animated />
                  </Stack>
                </Card>
              ) : null}
              {error ? (
                <Alert color="red" role="alert" title="That didn't work">
                  {error}
                </Alert>
              ) : null}
              {/* Setup stays mounted while the edits are applied, so a failure leaves them as they were. */}
              <div style={busy ? { display: 'none' } : undefined}>
                <DemoSetup
                  media={local.media}
                  {...(props.aspect ? { aspect: props.aspect } : {})}
                  onAttach={(r) => void add(local, r)}
                  onBack={() => {
                    setLocal(null)
                    setError(null)
                  }}
                />
              </div>
            </Stack>
          )}
        </Modal>
      ) : null}
    </>
  )
}
