// New video's "Record screen" button, beside Add media: record the screen without leaving the page, and when the
// recording is uploaded its setup (play, trim, crop, hide) opens in the same dialog. It's the /new/demo flow in a
// dialog, made of the same parts (RecordingSource opened on recording, then DemoSetup): "Make it" there creates the
// demo and goes to it. What was typed in the prompt box comes along.
import { Alert, Button, Loader, Modal } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { IconPlayerRecordFilled } from '@tabler/icons-react'
import { useState } from 'react'
import { $api, errorMessage } from '../../api/client'
import { DemoSetup } from './DemoSetup'
import { RecordingSource } from './RecordingSource'

export function RecordScreenButton(props: { prompt?: string; disabled?: boolean }) {
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
        variant="subtle"
        color="gray"
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
          title={mediaId ? 'Make a demo from your recording' : 'Record your screen'}
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
              initialPrompt={props.prompt ?? ''}
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
