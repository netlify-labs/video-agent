// The netlify-video skill is built with the site (scripts/build.ts) and already points at this deployment.
import { Anchor, Card, Code, Stack, Text } from '@mantine/core'
import { Link } from 'react-router'
import { MCP_PROMPTS } from '../../../../server/mcp-catalog'
import { CopyField, PageHeader } from '../../components/bits'
import { CatalogTable, DocSections } from './DocsLayout'

const SKILL_AGENTS: [string, string][] = [
  ['Claude Code', '~/.claude/skills'],
  ['Codex', '~/.codex/skills'],
  ['Cursor', '~/.cursor/skills'],
  ['Gemini CLI', '~/.gemini/skills'],
]

export default function SkillsGuidePage() {
  const zipUrl = `${window.location.origin}/skills/netlify-video.zip`
  return (
    <>
      <PageHeader
        title="Agent skills"
        sub={
          <>
            The <Code>netlify-video</Code> skill teaches your coding agent how to use this video agent:
            connecting the MCP server, the plan, create, follow and publish flow, and recipes such as turning
            a pull request into a demo video.
          </>
        }
      />
      <DocSections
        sections={[
          {
            id: 'package',
            title: 'Skill package',
            description: (
              <>
                It points at this site: install it, then connect the MCP server as shown under{' '}
                <Anchor component={Link} to="/docs/mcp#connect" c="var(--va-text)" inherit>
                  MCP for AI tools
                </Anchor>
                .
              </>
            ),
            children: (
              <Card>
                <Stack gap="sm">
                  <CopyField label="Skill package (zip)" value={zipUrl} />
                  <Text size="sm" c="var(--va-muted)">
                    It unzips to one <Code>netlify-video/</Code> folder with <Code>SKILL.md</Code> and its
                    references. Names, sizes and checksums are in{' '}
                    <Anchor href="/skills/index.json" c="var(--va-text)">
                      /skills/index.json
                    </Anchor>
                    .
                  </Text>
                </Stack>
              </Card>
            ),
          },
          {
            id: 'install',
            title: 'Install',
            description: 'One command per agent. Run it again to update.',
            children: (
              <Card>
                <Stack gap="sm">
                  {SKILL_AGENTS.map(([agent, dir]) => (
                    <CopyField
                      key={agent}
                      label={agent}
                      value={`curl -fsSL ${zipUrl} -o /tmp/netlify-video.zip && unzip -o /tmp/netlify-video.zip -d ${dir}/`}
                    />
                  ))}
                </Stack>
                <Text size="sm" c="var(--va-muted)" mt="sm">
                  For one project only, unzip into the project’s skills folder instead (for example{' '}
                  <Code>.claude/skills/</Code>). In the Claude apps, upload the zip under Settings →
                  Capabilities → Skills.
                </Text>
              </Card>
            ),
          },
          {
            id: 'prompts',
            title: 'MCP prompts',
            description: (
              <>
                The same recipes for clients without skills, from the MCP server (<Code>prompts/list</Code>),
                limited to what your role can do.
              </>
            ),
            children: (
              <Card>
                <CatalogTable entries={MCP_PROMPTS} label="MCP prompts" />
              </Card>
            ),
          },
        ]}
      />
    </>
  )
}
