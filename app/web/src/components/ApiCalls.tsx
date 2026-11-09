// The API calls drawer: the REST calls behind what you just did, each with its operation in the API reference and a
// "Copy as curl" that uses an API key (from API keys) instead of the browser's session.
import { ActionIcon, Anchor, Badge, Button, CopyButton, Drawer, Group, Text, Tooltip } from '@mantine/core'
import { IconCheck, IconTerminal2 } from '@tabler/icons-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router'
import { clearCalls, curlFor, getCalls, loadOperations, subscribeCalls, type ApiCall } from '../api/calls'

type Operations = Awaited<ReturnType<typeof loadOperations>>

const METHOD_COLOR: Record<string, string> = {
  GET: 'blue',
  POST: 'green',
  PATCH: 'yellow',
  PUT: 'yellow',
  DELETE: 'red',
}

function summaryOf(ops: Operations, call: ApiCall): string | null {
  const path = call.path.split('?')[0] ?? ''
  return ops.find((o) => o.method === call.method && o.pattern.test(path))?.summary || null
}

export function ApiCallsDrawer({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const calls = useSyncExternalStore(subscribeCalls, getCalls)
  const [ops, setOps] = useState<Operations>([])
  useEffect(() => {
    if (opened) void loadOperations().then(setOps)
  }, [opened])

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="bottom"
      size="45%"
      title={
        <Group gap="xs">
          <Text fw={600}>API calls</Text>
          <Text size="sm" c="dimmed">
            what this page asked the{' '}
            <Anchor component={Link} to="/docs/api" onClick={onClose} inherit>
              REST API
            </Anchor>{' '}
            for, newest first
          </Text>
        </Group>
      }
    >
      <Group justify="space-between" mb="xs">
        <Text size="xs" c="dimmed">
          Copy as curl uses <code>$VIDEO_AGENT_API_KEY</code>: make one under{' '}
          <Anchor component={Link} to="/keys" onClick={onClose} inherit>
            API keys
          </Anchor>
          .
        </Text>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={clearCalls} disabled={!calls.length}>
          Clear
        </Button>
      </Group>
      {calls.length === 0 ? (
        <Text size="sm" c="dimmed" py="md">
          No calls yet. Use the app and they show up here.
        </Text>
      ) : (
        <ol className="va-calls">
          {calls.map((c) => {
            const summary = summaryOf(ops, c)
            const failed = c.status === null || c.status >= 400
            return (
              <li key={c.id}>
                <span className="va-calls-time">
                  {new Date(c.at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
                <Badge size="sm" variant="light" color={METHOD_COLOR[c.method] ?? 'gray'} w={64}>
                  {c.method}
                </Badge>
                <span className="va-calls-path">
                  <code>{c.path}</code>
                  {summary ? <span>{summary}</span> : null}
                </span>
                <Badge size="sm" variant="light" color={failed ? 'red' : 'gray'}>
                  {c.status ?? 'failed'}
                </Badge>
                <span className="va-calls-ms">{c.ms} ms</span>
                <CopyButton value={curlFor(c, window.location.origin)} timeout={1500}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? 'Copied' : 'Copy as curl'}>
                      <ActionIcon variant="subtle" color="gray" onClick={copy} aria-label="Copy as curl">
                        {copied ? <IconCheck size={16} /> : <IconTerminal2 size={16} />}
                      </ActionIcon>
                    </Tooltip>
                  )}
                </CopyButton>
              </li>
            )
          })}
        </ol>
      )}
    </Drawer>
  )
}
