export default function BuildCompatPage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: '#020617',
        color: '#cbd5e1',
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
      }}
    >
      <div style={{ maxWidth: 560, textAlign: 'center', lineHeight: 1.6 }}>
        This compatibility route keeps the legacy pages manifest available for standalone dashboard
        builds.
      </div>
    </main>
  )
}
