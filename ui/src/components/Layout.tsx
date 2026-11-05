import {
  ActionIcon,
  AppShell,
  Burger,
  Group,
  Menu,
  NavLink,
  Text,
  Tooltip,
  UnstyledButton,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core'
import { useDisclosure, useHotkeys } from '@mantine/hooks'
import { Fragment, useState } from 'react'
import {
  IconBook,
  IconKey,
  IconLayoutGrid,
  IconPhoto,
  IconLogout,
  IconMoon,
  IconPlus,
  IconSettings,
  IconShieldLock,
  IconSun,
} from '@tabler/icons-react'
import { Link, NavLink as RouterLink, Outlet, useLocation, useNavigate } from 'react-router'
import { $api } from '../api/client'
import { DOCS_GROUPS, DOCS_PAGES } from '../pages/docs/nav'
import { useAuth } from '../auth'
import { brand } from '../theme'
import { Mark, PoweredBy } from './bits'
import { MissingSettingsBanner } from './MissingSettings'
import { NotificationBell } from './NotificationBell'

export function Layout() {
  const [opened, { toggle, close }] = useDisclosure()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const auth = useAuth()
  const { colorScheme, toggleColorScheme } = useMantineColorScheme()
  const computedScheme = useComputedColorScheme('dark')
  const me = $api.useQuery('get', '/api/v1/me')
  const health = $api.useQuery('get', '/api/health', {}, { staleTime: 60_000 })
  const usage = $api.useQuery('get', '/api/v1/me/usage', {}, { staleTime: 60_000 })
  const isAdmin = me.data?.role === 'admin'
  const canCreate = isAdmin || me.data?.role === 'creator'
  useHotkeys(canCreate ? [['n', () => void navigate('/new')]] : [])

  // The API docs group opens whenever a docs page is open, and can be folded by hand.
  const onDocs = pathname === '/docs' || pathname.startsWith('/docs/')
  const [docsOpened, setDocsOpened] = useState(onDocs)
  const [wasOnDocs, setWasOnDocs] = useState(onDocs)
  if (onDocs !== wasOnDocs) {
    setWasOnDocs(onDocs)
    if (onDocs) setDocsOpened(true)
  }

  const link = (to: string, label: string, icon?: React.ReactNode) => (
    <NavLink
      component={RouterLink}
      to={to}
      label={label}
      leftSection={icon}
      className="va-navlink"
      active={to === '/' ? pathname === '/' || pathname.startsWith('/videos') : pathname.startsWith(to)}
      onClick={close}
    />
  )
  // brand.logo is for dark backgrounds; logoLight (when the brand has one) for the light theme.
  const logo = computedScheme === 'light' ? (brand.logoLight ?? brand.logo) : brand.logo
  const initial = (me.data?.name ?? me.data?.email ?? '?').slice(0, 1).toUpperCase()

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 220, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="lg"
      classNames={{ header: 'va-shell-edge', navbar: 'va-shell-edge', main: 'va-shell-main' }}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Menu" />
            <Link to="/" className="va-mark">
              {logo ? <img src={logo} alt="" height={28} /> : <Mark />}
              {brand.appName}
            </Link>
          </Group>
          <Group gap="sm">
            {health.data && !health.data.ready && isAdmin ? (
              <Link
                to="/setup"
                style={{ color: 'var(--va-warning-ink)', fontSize: 13, textDecoration: 'none' }}
              >
                Setup incomplete
              </Link>
            ) : null}
            <NotificationBell />
            <Tooltip label={colorScheme === 'dark' ? 'Light theme' : 'Dark theme'}>
              <ActionIcon variant="subtle" color="gray" onClick={toggleColorScheme} aria-label="Toggle theme">
                {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
              </ActionIcon>
            </Tooltip>
            {/* As wide as its lines (an email can be long), at least 240 px, never wider than the screen. */}
            <Menu
              position="bottom-end"
              width="max-content"
              styles={{ dropdown: { minWidth: 240, maxWidth: 'calc(100vw - 24px)' } }}
            >
              <Menu.Target>
                <UnstyledButton aria-label="Account" className="va-avatar">
                  {initial}
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>
                  {me.data?.email}
                  {me.data?.role ? ` · ${me.data.role}` : ''}
                </Menu.Label>
                {usage.data ? (
                  <Menu.Label>
                    This month:{' '}
                    {Math.round(usage.data.runs.credits + usage.data.planning.credits).toLocaleString(
                      'en-US',
                    )}{' '}
                    credits
                    {usage.data.planning.credits > 0 ? (
                      <>
                        <br />
                        including {usage.data.planning.credits.toFixed(1)} for planning
                      </>
                    ) : null}
                  </Menu.Label>
                ) : null}
                <Menu.Item
                  leftSection={<IconLogout size={16} />}
                  onClick={() => void auth.logout().then(() => navigate('/'))}
                >
                  Sign out
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        {canCreate ? link('/new', 'New video', <IconPlus size={18} />) : null}
        {link('/', 'Library', <IconLayoutGrid size={18} />)}
        {link('/media', 'Media', <IconPhoto size={18} />)}
        {link('/keys', 'API keys', <IconKey size={18} />)}
        {isAdmin ? link('/admin', 'Admin', <IconShieldLock size={18} />) : null}
        {isAdmin ? link('/setup', 'Setup', <IconSettings size={18} />) : null}
        <NavLink
          component="button"
          type="button"
          label="API docs"
          leftSection={<IconBook size={18} />}
          className="va-navlink"
          opened={docsOpened}
          onChange={setDocsOpened}
          active={onDocs && !docsOpened}
          childrenOffset={28}
        >
          {DOCS_GROUPS.map((group) => {
            const pages = DOCS_PAGES.filter((p) => p.group === group)
            return pages.length ? (
              <div key={group} role="group" aria-label={group}>
                <Text size="xs" c="dimmed" fw={600} tt="uppercase" px="sm" pt={6} pb={2} aria-hidden>
                  {group}
                </Text>
                {pages.map((p) => (
                  <Fragment key={p.path}>{link(p.path, p.label)}</Fragment>
                ))}
              </div>
            ) : null
          })}
        </NavLink>
        <PoweredBy inSidebar />
      </AppShell.Navbar>
      <AppShell.Main>
        <MissingSettingsBanner admin={isAdmin} />
        <Outlet />
      </AppShell.Main>
    </AppShell>
  )
}
