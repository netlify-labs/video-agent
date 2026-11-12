// The create-video and video-agent-cli skills are built with the site (scripts/build.ts) and already point at this
// deployment.
import { Anchor, Card, Code, List, Stack, Text } from '@mantine/core'
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
  [
    'create-video',
    'What to make and how to make it. It covers planning, creating, following, and publishing a video, plus recipes and the SDK.',
  ],
  ['video-agent-cli', 'Every command of the video-agent CLI, for agents that have a shell.'],
]

export default function SkillsGuidePage() {
  const origin = window.location.origin
  const install = (dir: string) =>
    `for s in ${SKILLS.map(([name]) => name).join(' ')}; do curl -fsSL ${origin}/skills/$s.zip -o /tmp/$s.zip && unzip -o /tmp/$s.zip -d ${dir}/; done`
  return (
    <>
      <PageHeader
        title="Agent skills"
        sub="Two skills teach your coding agent how to use this Video Agent: one for making videos, and one for the CLI."
      />
      <DocSections
        sections={[
          {
            id: 'package',
            title: 'Skill packages',
            description: (
              <>
                The skills already point at this site. After you install them, connect the MCP server. For the
                steps, see{' '}
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
                  <List size="sm" spacing={4}>
                    {SKILLS.map(([name, what]) => (
                      <List.Item key={name}>
                        <Code>{name}</Code>: {what}
                      </List.Item>
                    ))}
                  </List>
                  <Text size="sm" c="var(--va-muted)">
                    Each zip file unpacks to one folder that&apos;s named after the skill. The folder holds a{' '}
                    <Code>SKILL.md</Code> file and its reference files. For names, sizes, and checksums, see{' '}
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
            description:
              'One command for each agent installs both skills. To update them, run the command again.',
            children: (
              <Card>
                <Stack gap="sm">
                  {SKILL_AGENTS.map(([agent, dir]) => (
                    <CopyField key={agent} label={agent} value={install(dir)} />
                  ))}
                </Stack>
                <Text size="sm" c="var(--va-muted)" mt="sm">
                  To install the skills for one project only, unzip them into that project&apos;s skills
                  folder, for example <Code>.claude/skills/</Code>. In the Claude apps, go to{' '}
                  <b>Settings &gt; Capabilities &gt; Skills</b> and upload each zip file.
                </Text>
              </Card>
            ),
          },
          {
            id: 'prompts',
            title: 'MCP prompts',
            description: (
              <>
                Clients without skills can get the same recipes from the MCP server as prompts (
                <Code>prompts/list</Code>). You see only the prompts that your role can use.
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
