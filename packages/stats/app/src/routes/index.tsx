import { A } from "@solidjs/router"

export default function Home() {
  return (
    <main class="shell">
      <section class="panel">
        <div>
          <p class="eyebrow">OpenCode Stats</p>
          <h1>Rankings live here.</h1>
          <p class="summary">
            This new site is ready for the rankings experience, with server-side Effect runtime and Drizzle schema
            stubs split into the stats core package.
          </p>
          <A class="link" href="/rankings">
            View rankings scaffold
          </A>
        </div>
        <div class="grid" aria-label="Stats scaffold status">
          <div class="metric">
            <b>01</b>
            <span>SolidStart app</span>
          </div>
          <div class="metric">
            <b>02</b>
            <span>Effect runtime</span>
          </div>
          <div class="metric">
            <b>03</b>
            <span>Drizzle schema</span>
          </div>
        </div>
      </section>
    </main>
  )
}
