// New video -> From a screen recording (screen-recording plan §4.3–4.5; va-rsk5.4.1, va-rsk5.4.2, va-rsk5.4.7): first
// the recording (upload, library or record here), then setup. ?media=<id> opens setup for that recording, so a reload
// or the back button keeps the step.
import { Alert, Loader, Stack } from '@mantine/core'
import { useSearchParams } from 'react-router'
import { $api, errorMessage } from '../api/client'
import { PageHeader } from '../components/bits'
import { DemoSetup } from '../components/recording/DemoSetup'
import { RecordingSource } from '../components/recording/RecordingSource'

export function NewDemoPage() {
  const [params, setParams] = useSearchParams()
  const mediaId = params.get('media')
  const media = $api.useQuery(
    'get',
    '/api/v1/media/{id}',
    { params: { path: { id: mediaId ?? '' } } },
    { enabled: Boolean(mediaId) },
  )
  return (
    <Stack gap="lg" maw={920}>
      <PageHeader
        title="Make a demo from a screen recording"
        sub="Video Agent finds the steps, zooms in on the action, cuts the waiting and adds a callout per step."
      />
      {!mediaId ? (
        <RecordingSource
          onReady={(id) => {
            setParams({ media: id })
          }}
        />
      ) : media.isPending ? (
        <Loader size="sm" />
      ) : media.isError ? (
        <Alert color="red">{errorMessage(media.error)}</Alert>
      ) : media.data.role !== 'screen-recording' ? (
        <Alert color="red">That item isn't a screen recording.</Alert>
      ) : (
        <DemoSetup
          media={media.data}
          onBack={() => {
            setParams({})
          }}
        />
      )}
    </Stack>
  )
}
