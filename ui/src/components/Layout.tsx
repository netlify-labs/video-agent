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
  useMantineColorScheme,
} from '@mantine/core'
import { useDisclosure, useHotkeys } from '@mantine/hooks'
import {
  IconBook,
  IconKey,
  IconLayoutGrid,
  IconLogout,
  IconMoon,
  IconPlus,
  IconSettings,
  IconShieldLock,
  IconSun,
} from '@tabler/icons-react'
import { Link, NavLink as RouterLink, Outlet, useLocation, useNavigate } from 'react-router'
import { $api } from '../api/client'
import { useAuth } from '../auth'
import { brand } from '../theme'
import { Mark, PoweredBy } from './bits'

export function Layout() {
  const [opened, { toggle, close }] = useDisclosure()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const auth = useAuth()
  const { colorScheme, toggleColorScheme } = useMantineColorScheme()
  const me = $api.useQuery('get', '/api/v1/me')
  const health = $api.useQuery('get', '/api/health', {}, { staleTime: 60_000 })
  const isAdmin = me.data?.role === 'admin'
  useHotkeys([['n', () => void navigate('/new')]])

  const link = (to: string, label: string, icon: React.ReactNode) => (
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
              {brand.logo ? <img src={brand.logo} alt="" height={22} /> : <Mark />}
              {brand.name}
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
            <Tooltip label={colorScheme === 'dark' ? 'Light theme' : 'Dark theme'}>
              <ActionIcon variant="subtle" color="gray" onClick={toggleColorScheme} aria-label="Toggle theme">
                {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
              </ActionIcon>
            </Tooltip>
            <Menu position="bottom-end" width={240}>
              <Menu.Target>
                <UnstyledButton aria-label="Account" className="va-avatar">
                  {initial}
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>
                  {me.data?.email}
                  {isAdmin ? ' · admin' : ''}
                </Menu.Label>
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
        {link('/new', 'New video', <IconPlus size={18} />)}
        {link('/', 'Library', <IconLayoutGrid size={18} />)}
        {link('/keys', 'API keys', <IconKey size={18} />)}
        {isAdmin ? link('/admin', 'Admin', <IconShieldLock size={18} />) : null}
        {isAdmin ? link('/setup', 'Setup', <IconSettings size={18} />) : null}
        {link('/docs', 'API docs', <IconBook size={18} />)}
        <Text size="xs" c="var(--va-faint)" mt="auto" p="xs">
          Press N for a new video
        </Text>
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
        <PoweredBy />
      </AppShell.Main>
    </AppShell>
  )
}
