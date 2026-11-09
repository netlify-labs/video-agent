// The create-video and video-agent-cli skills are built with the site (scripts/build.ts) and already point at this
// deployment.
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

/** The skills each deployment serves (skills/ in the repo), installed together. */
const SKILLS: [string, string][] = [
  ['create-video', 'what to make and how: the plan, create, follow and publish flow, recipes, the SDK'],
  ['video-agent-cli', 'every command of the video-agent CLI, for agents with a shell'],
]

export default function SkillsGuidePage() {
  const origin = window.location.origin
  const install = (dir: string) =>
    `for s in ${SKILLS.map(([name]) => name).join(' ')}; do curl -fsSL ${origin}/skills/$s.zip -o /tmp/$s.zip && unzip -o /tmp/$s.zip -d ${dir}/; done`
  return (
    <>
      <PageHeader
        title="Agent skills"
        sub={
          <>
            Two skills teach your coding agent to use this video agent: <Code>create-video</Code> (the MCP
            tools, the plan, create, follow and publish flow, the SDK, and recipes such as turning a pull
            request into a demo video) and <Code>video-agent-cli</Code> (the CLI, for agents with a shell).
          </>
        }
      />
      <DocSections
        sections={[
          {
            id: 'package',
            title: 'Skill packages',
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
                  {SKILLS.map(([name]) => (
                    <CopyField key={name} label={`${name} (zip)`} value={`${origin}/skills/${name}.zip`} />
                  ))}
                  <Text size="sm" c="var(--va-muted)">
                    Each unzips to one folder named after the skill, with <Code>SKILL.md</Code> and its
                    references.
                    {SKILLS.map(([name, what]) => ` ${name}: ${what}.`).join('')} Names, sizes and checksums
                    are in{' '}
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
            description: 'One command per agent installs both. Run it again to update.',
            children: (
              <Card>
                <Stack gap="sm">
                  {SKILL_AGENTS.map(([agent, dir]) => (
                    <CopyField key={agent} label={agent} value={install(dir)} />
                  ))}
                </Stack>
                <Text size="sm" c="var(--va-muted)" mt="sm">
                  For one project only, unzip into the project’s skills folder instead (for example{' '}
                  <Code>.claude/skills/</Code>). In the Claude apps, upload each zip under Settings →
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
