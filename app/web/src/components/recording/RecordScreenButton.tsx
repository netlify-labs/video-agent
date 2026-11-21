// New video's "Record screen" button, beside Add media: record the screen without leaving the page. When the
// recording is uploaded, its setup (play, trim, crop, hide, privacy) opens in the same dialog, and "Add to video"
// puts it on the form like a picked media item. Create video then sends it as the request's `recording`, so the
// trim, crop and hidden areas all carry over. The same parts as /new/demo: RecordingSource opened on recording, then
// DemoSetup with only the recording's own settings.
import { Alert, Button, Loader, Modal } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { IconPlayerRecordFilled } from '@tabler/icons-react'
import { useState } from 'react'
import { $api, errorMessage } from '../../api/client'
import type { AttachedRecording } from '../../lib/demo-setup'
import { DemoSetup } from './DemoSetup'
import { RecordingSource } from './RecordingSource'

export function RecordScreenButton(props: {
  onAttach: (r: AttachedRecording) => void
  /** The form's shape (for setup's note about small recordings). */
  aspect?: '16:9' | '9:16' | '1:1' | '4:5'
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [mediaId, setMediaId] = useState<string | null>(null)
  const phone = useMediaQuery('(max-width: 48em)')
  const media = $api.useQuery(
    'get',
    '/api/v1/media/{id}',
    { params: { path: { id: mediaId ?? '' } } },
    { enabled: Boolean(mediaId) },
  )
  const close = () => {
    setOpen(false)
    setMediaId(null)
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
          title={mediaId ? 'Set up your recording' : 'Record your screen'}
          size={mediaId ? 960 : 'lg'}
          padding={phone ? 'md' : 'xl'}
          fullScreen={phone}
          // A stray click outside shouldn't throw a recording away; the close button and Escape still close it.
          closeOnClickOutside={false}
          closeButtonProps={{ 'aria-label': 'Close' }}
          centered={!mediaId}
        >
          {!mediaId ? (
            <RecordingSource initial="record" onCancel={close} onReady={setMediaId} />
          ) : media.isPending ? (
            <Loader size="sm" />
          ) : media.isError ? (
            <Alert color="red">{errorMessage(media.error)}</Alert>
          ) : (
            <DemoSetup
              media={media.data}
              {...(props.aspect ? { aspect: props.aspect } : {})}
              onAttach={(r) => {
                props.onAttach(r)
                close()
              }}
              onBack={() => {
                setMediaId(null)
              }}
            />
          )}
        </Modal>
      ) : null}
    </>
  )
}
