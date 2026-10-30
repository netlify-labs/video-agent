import { Alert, Anchor, Badge, Button, Card, Group, Select, SimpleGrid, Stack, Switch, Table, Text, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useQueryClient } from '@tanstack/react-query'
import { Link, Navigate } from 'react-router'
import { $api, errorMessage } from '../api/client'
import { relativeTime } from '../components/bits'

export function AdminPage() {
  const qc = useQueryClient()
  const me = $api.useQuery('get', '/api/v1/me')
  const stats = $api.useQuery('get', '/api/v1/stats', {}, { refetchInterval: 15_000, enabled: me.data?.role === 'admin' })
  const users = $api.useQuery('get', '/api/v1/users', {}, { enabled: me.data?.role === 'admin' })
  const onError = (e: unknown) => notifications.show({ color: 'red', message: errorMessage(e) })
  const update = $api.useMutation('patch', '/api/v1/users/{id}', { onSuccess: () => void qc.invalidateQueries(), onError })
  const resolve = $api.useMutation('post', '/api/v1/admin/attempts/{id}/resolve', { onSuccess: () => void qc.invalidateQueries(), onError })
  const resume = $api.useMutation('post', '/api/v1/admin/queue/resume', { onSuccess: () => void qc.invalidateQueries(), onError })
  const cancel = $api.useMutation('post', '/api/v1/videos/{id}/versions/{n}/cancel', { onSuccess: () => void qc.invalidateQueries(), onError })

  if (me.data && me.data.role !== 'admin') return <Navigate to="/" replace />
  const s = stats.data
  const credits = (s?.usage ?? []).reduce((sum, u) => sum + (u.credits ?? 0), 0)

  return (
    <Stack>
      <Title order={2}>Admin</Title>
      {s?.queuePausedReason ? (
        <Alert color="red" title="New runs are paused">
          <Group justify="space-between">
            <Text size="sm">{s.queuePausedReason} Fix it in your Netlify team, then resume.</Text>
            <Button size="xs" loading={resume.isPending} onClick={() => { resume.mutate({}) }}>Resume</Button>
          </Group>
        </Alert>
      ) : null}
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        {[
          ['Running', `${s?.inFlight.length ?? 0} / ${s?.maxActiveRuns ?? '–'}`],
          ['Queued', `${s?.queued ?? 0}${s?.oldestQueuedAt ? ` · oldest ${relativeTime(s.oldestQueuedAt)}` : ''}`],
          ['Failures this week', String((s?.failuresThisWeek ?? []).reduce((n, f) => n + f.count, 0))],
          ['Credits (5 weeks)', credits.toFixed(0)],
        ].map(([label, value]) => (
          <Card key={label} withBorder padding="md" radius="md">
            <Text size="sm" c="dimmed">{label}</Text>
            <Text size="xl" fw={650}>{value}</Text>
          </Card>
        ))}
      </SimpleGrid>

      <Card withBorder radius="md">
        <Text fw={600} mb="xs">Runs in flight</Text>
        {(s?.inFlight ?? []).length === 0 ? <Text size="sm" c="dimmed">Nothing running.</Text> : (
          <Table>
            <Table.Tbody>
              {s?.inFlight.map((a) => (
                <Table.Tr key={a.attemptId}>
                  <Table.Td><Anchor component={Link} to={`/videos/${a.jobId}`}>{a.jobId} v{a.versionN}</Anchor></Table.Td>
                  <Table.Td><Badge variant="light">{a.stage}</Badge></Table.Td>
                  <Table.Td>{a.startedAt ? relativeTime(a.startedAt) : '—'}</Table.Td>
                  <Table.Td>{a.runUrl ? <Anchor href={a.runUrl} target="_blank" size="sm">Run</Anchor> : null}</Table.Td>
                  <Table.Td align="right">
                    {a.stage === 'running' || a.stage === 'starting' ? (
                      <Button size="xs" variant="subtle" color="red" onClick={() => { cancel.mutate({ params: { path: { id: a.jobId, n: a.versionN } } }) }}>Stop</Button>
                    ) : null}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>

      {(s?.unresolved ?? []).length > 0 ? (
        <Card withBorder radius="md">
          <Text fw={600}>Unresolved starts</Text>
          <Text size="sm" c="dimmed" mb="xs">
            The service couldn't confirm whether these runs started. Check the run list in Netlify; if nothing is running for them, resolve to free the slot.
          </Text>
          <Table>
            <Table.Tbody>
              {s?.unresolved.map((a) => (
                <Table.Tr key={a.attemptId}>
                  <Table.Td><Anchor component={Link} to={`/videos/${a.jobId}`}>{a.jobId} v{a.versionN}</Anchor></Table.Td>
                  <Table.Td align="right"><Button size="xs" onClick={() => { resolve.mutate({ params: { path: { id: a.attemptId } } }) }}>Mark failed</Button></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      ) : null}

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card withBorder radius="md">
          <Text fw={600} mb="xs">Failures this week</Text>
          {(s?.failuresThisWeek ?? []).length === 0 ? <Text size="sm" c="dimmed">None.</Text> : (
            <Table><Table.Tbody>{s?.failuresThisWeek.map((f) => <Table.Tr key={f.category}><Table.Td>{f.category}</Table.Td><Table.Td align="right">{f.count}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
          )}
        </Card>
        <Card withBorder radius="md">
          <Text fw={600} mb="xs">Credits by person and week</Text>
          <Table>
            <Table.Thead><Table.Tr><Table.Th>Who</Table.Th><Table.Th>Week of</Table.Th><Table.Th>Videos</Table.Th><Table.Th>Credits</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {(s?.usage ?? []).sort((a, b) => b.week.localeCompare(a.week)).map((u) => (
                <Table.Tr key={`${u.userId}-${u.week}`}>
                  <Table.Td>{u.email ?? u.userId}</Table.Td><Table.Td>{u.week}</Table.Td><Table.Td>{u.videos}</Table.Td>
                  <Table.Td>{u.credits === null ? 'unknown' : u.credits.toFixed(0)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      </SimpleGrid>

      <Card withBorder radius="md">
        <Text fw={600} mb="xs">People</Text>
        <Table>
          <Table.Thead><Table.Tr><Table.Th>Email</Table.Th><Table.Th>Joined</Table.Th><Table.Th>Role</Table.Th><Table.Th>Active</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>
            {(users.data ?? []).map((u) => (
              <Table.Tr key={u.id}>
                <Table.Td>{u.email}{u.id === me.data?.id ? ' (you)' : ''}</Table.Td>
                <Table.Td>{relativeTime(u.createdAt)}</Table.Td>
                <Table.Td>
                  <Select size="xs" w={120} value={u.role} data={['member', 'admin']} allowDeselect={false} onChange={(role) => { if (role) update.mutate({ params: { path: { id: u.id } }, body: { role: role } }) }} />
                </Table.Td>
                <Table.Td>
                  <Switch checked={!u.disabled} onChange={(e) => { update.mutate({ params: { path: { id: u.id } }, body: { disabled: !e.currentTarget.checked } }) }} aria-label="Active" />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Text size="xs" c="dimmed" mt="xs">Disabling someone also revokes their API keys. To invite people, use Identity in your Netlify project settings.</Text>
      </Card>
    </Stack>
  )
}
