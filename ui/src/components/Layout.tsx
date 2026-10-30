import {
  ActionIcon,
  Burger,
  Drawer,
  Menu,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core'
import { useDisclosure, useHotkeys, useWindowScroll } from '@mantine/hooks'
import { IconLogout, IconMoon, IconSun } from '@tabler/icons-react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router'
import { $api } from '../api/client'
import { useAuth } from '../auth'
import { brand } from '../theme'
import { Mark, PoweredBy } from './bits'

export function Layout() {
  const navigate = useNavigate()
  const auth = useAuth()
  const [menu, { open, close }] = useDisclosure()
  const [scroll] = useWindowScroll()
  const { colorScheme, toggleColorScheme } = useMantineColorScheme()
  const me = $api.useQuery('get', '/api/v1/me')
  const health = $api.useQuery('get', '/api/health', {}, { staleTime: 60_000 })
  const isAdmin = me.data?.role === 'admin'
  useHotkeys([['n', () => void navigate('/new')]])

  const links = [
    { to: '/', label: 'Videos', end: true },
    { to: '/keys', label: 'API keys' },
    ...(isAdmin
      ? [
          { to: '/admin', label: 'Admin' },
          { to: '/setup', label: 'Setup' },
        ]
      : []),
  ]
  const initial = (me.data?.name ?? me.data?.email ?? '?').slice(0, 1).toUpperCase()

  return (
    <>
      <header className="va-bar" {...(scroll.y > 4 ? { 'data-scrolled': true } : {})}>
        <div className="va-column va-bar-inner">
          <Link to="/" className="va-mark">
            <Mark />
            {brand.name}
          </Link>
          <nav className="va-nav" aria-label="Main">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end ?? false}>
                {l.label}
              </NavLink>
            ))}
            <a href="/api/docs" target="_blank" rel="noreferrer">
              API docs
            </a>
          </nav>
          <div style={{ flex: 1 }} />
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
              <UnstyledButton
                aria-label="Account"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  background: 'var(--va-raised)',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
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
          <Burger opened={menu} onClick={open} hiddenFrom="sm" size="sm" aria-label="Menu" />
        </div>
      </header>
      <Drawer
        opened={menu}
        onClose={close}
        position="right"
        size="100%"
        title={<Text fw={600}>{brand.name}</Text>}
      >
        <Stack gap="lg">
          {[...links, { to: '/new', label: 'New video' }].map((l) => (
            <Link
              key={l.to}
              to={l.to}
              onClick={close}
              style={{ color: 'var(--va-text)', fontSize: 18, textDecoration: 'none' }}
            >
              {l.label}
            </Link>
          ))}
          <a
            href="/api/docs"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--va-text)', fontSize: 18, textDecoration: 'none' }}
          >
            API docs
          </a>
        </Stack>
      </Drawer>
      <main className="va-column va-main">
        <Outlet />
      </main>
      <PoweredBy />
    </>
  )
}
