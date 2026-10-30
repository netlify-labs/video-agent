import { ActionIcon, Alert, AppShell, Avatar, Burger, Group, Menu, NavLink, Text, Tooltip, useMantineColorScheme } from '@mantine/core'
import { useDisclosure, useHotkeys } from '@mantine/hooks'
import { IconBook, IconKey, IconLayoutGrid, IconLogout, IconMoon, IconPlus, IconSettings, IconShieldLock, IconSun } from '@tabler/icons-react'
import { NavLink as RouterLink, Outlet, useLocation, useNavigate } from 'react-router'
import { $api } from '../api/client'
import { useAuth } from '../auth'
import { brand } from '../theme'

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
    <NavLink component={RouterLink} to={to} label={label} leftSection={icon} active={to === '/' ? pathname === '/' || pathname.startsWith('/videos') : pathname.startsWith(to)} onClick={close} />
  )

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 220, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Menu" />
            {brand.logo ? <img src={brand.logo} alt="" height={24} /> : null}
            <Text fw={650}>{brand.name}</Text>
          </Group>
          <Group gap="xs">
            <Tooltip label={colorScheme === 'dark' ? 'Light mode' : 'Dark mode'}>
              <ActionIcon variant="subtle" color="gray" onClick={toggleColorScheme} aria-label="Toggle color scheme">
                {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
              </ActionIcon>
            </Tooltip>
            <Menu position="bottom-end">
              <Menu.Target>
                <ActionIcon variant="subtle" radius="xl" size="lg" aria-label="Account">
                  <Avatar size={30} radius="xl" color="brand">
                    {(me.data?.name ?? me.data?.email ?? '?').slice(0, 1).toUpperCase()}
                  </Avatar>
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{me.data?.email}</Menu.Label>
                <Menu.Item leftSection={<IconLogout size={16} />} onClick={() => void auth.logout().then(() => navigate('/'))}>
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
        <NavLink href="/api/docs" target="_blank" label="API docs" leftSection={<IconBook size={18} />} />
      </AppShell.Navbar>
      <AppShell.Main>
        {health.data && !health.data.ready && isAdmin ? (
          <Alert color="yellow" mb="md" title="Setup isn't complete">
            New videos are paused until setup is finished. <RouterLink to="/setup">Open setup</RouterLink>
          </Alert>
        ) : null}
        <Outlet />
      </AppShell.Main>
    </AppShell>
  )
}
