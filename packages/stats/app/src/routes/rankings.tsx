import "./rankings.css"
import { Meta, Title } from "@solidjs/meta"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { scaleBand, scaleLinear } from "d3-scale"
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"

const products = ["All Users", "Zen", "Go", "Enterprise"] as const
const tokenProducts = ["Zen", "Go", "Enterprise"] as const
const ranges = ["1D", "1W", "1M", "3M", "YTD", "ALL"] as const
const usageColors = ["#ff5d64", "#ff8a00", "#8bef00", "#12c8b3", "#18c7dc", "#6c7dff", "#9d73f7"]
const marketColors = ["#ed6aff", "#a684ff", "#7c86ff", "#51a2ff", "#00d3f2", "#00d5be", "#00bc7d", "#9ae600", "#ffb900"]
const usageModels = [
  "minimax-m2.5-free",
  "big-pickle",
  "kimi-k2.5",
  "gpt-5-nano",
  "nemotron-3-super-free",
  "claude-opus-4-6",
  "Other",
] as const

type UsageProduct = (typeof products)[number]
type TokenProduct = (typeof tokenProducts)[number]
type UsageRange = (typeof ranges)[number]
type UsagePoint = { date: string; segments: { model: string; value: number }[] }
type MarketDay = { date: string; total: number; authors: { author: string; share: number; tokens: number }[] }
type LeaderboardEntry = {
  model: string
  author: string
  tokens: number
  change: number
  products: readonly UsageProduct[]
}

const usageValues = [
  [0.42, 0.34, 0.22, 0.18, 0.16, 0.1, 0.58],
  [0.76, 0.66, 0.5, 0.34, 0.27, 0.2, 1.18],
  [0.92, 0.72, 0.48, 0.32, 0.26, 0.19, 1.11],
  [0.58, 0.46, 0.35, 0.26, 0.22, 0.17, 0.76],
  [1.8, 1.5, 0.27, 0.08, 0.23, 0.12, 0.75],
  [1.74, 1.38, 1.02, 0.78, 0.68, 0.56, 1.34],
  [1.94, 1.58, 1.18, 0.88, 0.73, 0.64, 1.48],
] as const

const usageDates = {
  "1D": ["12AM", "4AM", "8AM", "12PM", "4PM", "8PM", "NOW"],
  "1W": ["MAR 6", "MAR 7", "MAR 8", "MAR 9", "MAR 10", "MAR 11", "MAR 12"],
  "1M": ["FEB 14", "FEB 19", "FEB 24", "MAR 1", "MAR 6", "MAR 11", "MAR 16"],
  "3M": ["DEC 16", "JAN 1", "JAN 17", "FEB 2", "FEB 18", "MAR 6", "MAR 16"],
  YTD: ["JAN", "JAN", "FEB", "FEB", "MAR", "MAR", "NOW"],
  ALL: ["2024", "Q3", "Q4", "JAN", "FEB", "MAR", "NOW"],
} satisfies Record<UsageRange, readonly string[]>

const usageProductMultipliers = {
  "All Users": 1,
  Zen: 0.46,
  Go: 0.34,
  Enterprise: 0.22,
} satisfies Record<UsageProduct, number>

const usageRangeMultipliers = {
  "1D": 0.14,
  "1W": 1,
  "1M": 3.8,
  "3M": 10.6,
  YTD: 18.4,
  ALL: 31.2,
} satisfies Record<UsageRange, number>

const marketTotals = {
  "1D": [0.32, 0.61, 0.68, 0.47, 0.51, 0.84, 0.9],
  "1W": [2, 3.9, 4, 2.8, 2.8, 7.5, 7.5],
  "1M": [8.4, 10.6, 12.8, 11.9, 13.2, 15.7, 16.1],
  "3M": [22.4, 28.1, 32.7, 30.4, 34.8, 39.9, 42.2],
  YTD: [34.8, 43.1, 52.6, 58.2, 64.1, 72.8, 79.4],
  ALL: [91.2, 118.4, 142.7, 166.3, 188.9, 221.6, 246.8],
} satisfies Record<UsageRange, readonly number[]>

const leaderboard: readonly LeaderboardEntry[] = [
  { model: "GPT-5.4-mini", author: "OpenAI", tokens: 314, change: 17, products: ["All Users", "Zen", "Go"] },
  { model: "minimax-m2.5-free", author: "MiniMax", tokens: 286, change: 11, products: ["All Users", "Zen"] },
  { model: "kimi-k2.5", author: "Moonshot", tokens: 252, change: -3, products: ["All Users", "Go", "Enterprise"] },
  { model: "claude-sonnet-4-6", author: "Anthropic", tokens: 219, change: -2, products: ["All Users", "Enterprise"] },
  { model: "gemini-3-flash", author: "Google", tokens: 201, change: 6, products: ["All Users", "Go"] },
  { model: "glm-5", author: "Zhipu", tokens: 177, change: -8, products: ["All Users", "Enterprise"] },
  { model: "gpt-5.3-codex", author: "OpenAI", tokens: 152, change: 10, products: ["All Users", "Zen", "Enterprise"] },
  { model: "claude-haiku-4-5", author: "Anthropic", tokens: 130, change: 14, products: ["All Users", "Zen"] },
  { model: "nemotron-3-super-free", author: "Nvidia", tokens: 117, change: -5, products: ["All Users", "Go"] },
  { model: "gemini-3.1-pro", author: "Google", tokens: 96, change: 1, products: ["All Users", "Enterprise"] },
  { model: "minimax-m2.7", author: "MiniMax", tokens: 81, change: -4, products: ["All Users", "Go"] },
  { model: "gpt-5.4", author: "OpenAI", tokens: 64, change: 5, products: ["All Users", "Enterprise"] },
  { model: "claude-opus-4-6", author: "Anthropic", tokens: 52, change: 2, products: ["All Users", "Enterprise"] },
]

const market = [
  { author: "OpenCode", share: 23.1, tokens: "1.33T", values: [18, 19, 23, 22, 24, 23, 25] },
  { author: "Minimax", share: 19.4, tokens: "1.12T", values: [14, 18, 17, 20, 18, 21, 19] },
  { author: "Xiaomi", share: 13.2, tokens: "762B", values: [10, 12, 14, 13, 13, 15, 14] },
  { author: "Moonshot", share: 11.8, tokens: "681B", values: [13, 11, 12, 10, 12, 11, 12] },
  { author: "Nvidia", share: 9.7, tokens: "560B", values: [8, 9, 8, 10, 9, 9, 10] },
  { author: "OpenAI", share: 8.6, tokens: "496B", values: [12, 10, 9, 8, 9, 8, 8] },
  { author: "Anthropic", share: 6.9, tokens: "398B", values: [7, 6, 7, 7, 6, 7, 7] },
  { author: "Zhipu", share: 4.1, tokens: "236B", values: [4, 5, 4, 4, 4, 4, 4] },
  { author: "Other", share: 3.2, tokens: "184B", values: [14, 10, 6, 6, 5, 2, 1] },
]

const tokenCosts = [
  ["minimax-m2.5", 0.06],
  ["minimax-m2.7", 0.09],
  ["gemini-3-flash", 0.11],
  ["kimi-k2.5", 0.16],
  ["gpt-5.4-mini", 0.16],
  ["claude-haiku-4-5", 0.2],
  ["glm-5", 0.28],
  ["gpt-5.3-codex", 0.41],
  ["gemini-3.1-pro", 0.43],
  ["gpt-5.4", 0.54],
  ["claude-sonnet-4-6", 0.61],
  ["claude-sonnet-4-5", 0.61],
  ["claude-opus-4-6", 1.02],
] as const

const sessionCosts = [
  ["gpt-5.4-nano", 0.0228, "212K"],
  ["gpt-5.1-codex-mini", 0.0716, "534K"],
  ["minimax-m2.5", 0.1058, "898K"],
  ["claude-haiku-4-5", 0.1456, "734K"],
  ["gpt-5.4-mini", 0.1817, "646K"],
  ["minimax-m2.7", 0.2035, "715K"],
  ["gpt-5.4", 0.2228, "488K"],
  ["kimi-k2.5", 0.2646, "1.1M"],
  ["gemini-3-flash", 0.273, "829K"],
  ["glm-5", 0.3591, "925K"],
  ["claude-sonnet-4-6", 0.7608, "1.4M"],
  ["gpt-5.3-codex", 0.7784, "1.2M"],
  ["claude-sonnet-4-5", 1.001, "1.6M"],
  ["gemini-3.1-pro", 1.0831, "1.5M"],
  ["claude-opus-4-6", 2.6844, "2.2M"],
  ["claude-opus-4-5", 2.2732, "2.0M"],
  ["gpt-5.4-pr", 5.186, "3.3M"],
] as const

const countries = [
  ["United States", "520B", 30, 44, 28],
  ["Canada", "130B", 24, 30, 16],
  ["Brazil", "88B", 37, 70, 12],
  ["Germany", "112B", 52, 39, 14],
  ["India", "184B", 68, 58, 18],
  ["Japan", "92B", 84, 50, 12],
] as const

export default function Rankings() {
  return (
    <main data-page="rankings">
      <Title>Model Rankings | opencode</Title>
      <Meta
        name="description"
        content="OpenCode model rankings across usage, market share, token cost, session cost, and country trends."
      />
      <div data-component="container">
        <Header />
        <div data-component="content">
          <section data-section="hero">
            <div>
              <h1>Model Rankings</h1>
              <p data-slot="meta">
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
                  <rect x="3" y="3" width="10" height="10" fill="currentColor" />
                  <rect x="7" y="6.5" width="2" height="4.5" fill="var(--rankings-layer-2)" />
                  <rect x="7" y="5" width="2" height="1" fill="var(--rankings-layer-2)" />
                </svg>
                <span>OpenCode data</span> <b>·</b> <em>Showing 25%</em>
              </p>
            </div>
            <p>
              See which models are winning real usage, how the mix shifts over time, and where momentum is moving each
              week.
            </p>
          </section>
          <UsageSection />
          <LeaderboardSection />
          <MarketShareSection />
          <TokenCostSection />
          <SessionCostSection />
          <ChartSection title="Token by Country" controls={<Controls includeProducts={true} />}>
            <CountryMap />
          </ChartSection>
          <Newsletter />
        </div>
        <Footer />
      </div>
      <Legal />
    </main>
  )
}

function ChartSection(props: { title: string; description?: string; controls?: JSX.Element; children: JSX.Element }) {
  return (
    <section data-section="chart">
      <div data-slot="section-header">
        <div>
          <h2>{props.title}</h2>
          {props.description && <p>{props.description}</p>}
        </div>
        {props.controls}
      </div>
      {props.children}
    </section>
  )
}

function Controls(props: { includeProducts?: boolean }) {
  return (
    <div data-component="controls">
      {props.includeProducts && <ProductPills />}
      <RangePills />
    </div>
  )
}

function UsageSection() {
  const [product, setProduct] = createSignal<UsageProduct>("All Users")
  const [range, setRange] = createSignal<UsageRange>("1W")
  const data = createMemo(() => getUsageData(product(), range()))

  return (
    <ChartSection title="Usage">
      <UsageChart data={data()} />
      <div data-slot="chart-footer">
        <RankingFilters product={product()} range={range()} onProductSelect={setProduct} onRangeSelect={setRange} />
      </div>
    </ChartSection>
  )
}

function RankingFilters(props: {
  product: UsageProduct
  range: UsageRange
  onProductSelect: (product: UsageProduct) => void
  onRangeSelect: (range: UsageRange) => void
}) {
  return (
    <>
      <FilterPills
        items={products}
        selected={props.product}
        label="Product filter"
        variant="product"
        onSelect={props.onProductSelect}
      />
      <FilterPills
        items={ranges}
        selected={props.range}
        label="Date range"
        variant="range"
        onSelect={props.onRangeSelect}
      />
    </>
  )
}

function FilterPills<T extends string>(props: {
  items: readonly T[]
  selected: T
  label: string
  variant: "product" | "range"
  onSelect: (item: T) => void
}) {
  return (
    <div data-component="usage-filter" data-variant={props.variant} role="radiogroup" aria-label={props.label}>
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.selected === item}
            data-active={props.selected === item ? "true" : undefined}
            onClick={() => props.onSelect(item)}
          >
            {item}
          </button>
        )}
      </For>
    </div>
  )
}

function ProductPills(props: { live?: boolean }) {
  return (
    <div data-component="pills" aria-label="Product filter">
      <For each={props.live ? ["Zen", "Go", "Enterprise", "Live"] : products}>
        {(item, index) => <button data-active={index() === 0 ? "true" : undefined}>{item}</button>}
      </For>
    </div>
  )
}

function RangePills() {
  return (
    <div data-component="pills" aria-label="Date range">
      <For each={ranges}>
        {(item, index) => <button data-active={index() === 1 ? "true" : undefined}>{item}</button>}
      </For>
    </div>
  )
}

function UsageChart(props: { data: UsagePoint[] }) {
  const [activeIndex, setActiveIndex] = createSignal<number>()
  const [activeSegment, setActiveSegment] = createSignal<number>()
  const height = 434
  const width = 920
  const headerOffset = 46
  const segmentGap = 2
  const maxTotal = createMemo(() => Math.max(...props.data.map((item) => usageTotal(item))) * 1.02)
  const activePoint = createMemo(() => props.data[activeIndex() ?? -1])
  const y = createMemo(() => scaleLinear([0, maxTotal()], [height, 0]))
  const x = createMemo(() =>
    scaleBand(
      props.data.map((_, index) => String(index)),
      [0, width],
    ).paddingInner(0.08),
  )
  const activeBar = createMemo(() => {
    const index = activeIndex()
    const point = activePoint()
    if (index === undefined) return
    if (!point) return
    return {
      point,
      x: x()(String(index)) ?? 0,
      width: x().bandwidth(),
    }
  })

  return (
    <div data-component="usage-chart">
      <svg viewBox={`0 0 ${width} ${height + headerOffset}`} role="img" aria-label="Stacked usage chart">
        <defs>
          <pattern id="rankings-usage-dot-grid" width="6" height="6" patternUnits="userSpaceOnUse">
            <rect x="1" y="1" width="2" height="2" fill="var(--rankings-dot)" />
          </pattern>
        </defs>
        <For each={props.data}>
          {(day, dayIndex) => {
            const barX = x()(String(dayIndex())) ?? 0
            const barWidth = x().bandwidth()
            const stackTop = y()(usageTotal(day))
            return (
              <g
                role="button"
                tabIndex={0}
                aria-label={`${day.date} ${formatTokens(usageTotal(day))}`}
                data-active={activeIndex() === dayIndex() ? "true" : undefined}
                onPointerEnter={() => {
                  setActiveIndex(dayIndex())
                  setActiveSegment(undefined)
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType === "touch") return
                  setActiveIndex(undefined)
                  setActiveSegment(undefined)
                }}
                onClick={() => setActiveIndex(dayIndex())}
                onFocus={() => {
                  setActiveIndex(dayIndex())
                  setActiveSegment(undefined)
                }}
                onBlur={() => {
                  setActiveIndex(undefined)
                  setActiveSegment(undefined)
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return
                  event.preventDefault()
                  setActiveIndex(dayIndex())
                }}
              >
                <rect
                  x={barX}
                  y="0"
                  width={barWidth}
                  height={height + headerOffset}
                  fill="transparent"
                  pointer-events="all"
                />
                <text x={barX} y="17" class="chart-total">
                  {formatTokens(usageTotal(day))}
                </text>
                <text x={barX} y="34" class="chart-date">
                  {day.date}
                </text>
                <rect
                  x={barX}
                  y={headerOffset}
                  width={barWidth}
                  height={stackTop}
                  fill="url(#rankings-usage-dot-grid)"
                />
                <For each={day.segments}>
                  {(segment, index) => {
                    const previous = day.segments.slice(0, index()).reduce((sum, item) => sum + item.value, 0)
                    const segmentHeight = y()(previous) - y()(previous + segment.value)
                    const segmentInset = index() === day.segments.length - 1 ? 0 : segmentGap
                    return (
                      <rect
                        x={barX}
                        y={headerOffset + y()(previous + segment.value) + segmentInset}
                        width={barWidth}
                        height={Math.max(segmentHeight - segmentInset, 0)}
                        data-segment-active={
                          activeIndex() === dayIndex() && activeSegment() === index() ? "true" : undefined
                        }
                        opacity={getUsageSegmentOpacity(activeIndex() === dayIndex(), activeSegment(), index())}
                        fill={activeIndex() === dayIndex() ? usageColors[index()] : "var(--rankings-bar-idle)"}
                        onPointerEnter={(event) => {
                          event.stopPropagation()
                          setActiveIndex(dayIndex())
                          setActiveSegment(index())
                        }}
                      />
                    )
                  }}
                </For>
              </g>
            )
          }}
        </For>
      </svg>
      <Show when={activeBar()}>
        {(bar) => (
          <div
            data-component="chart-tooltip"
            data-placement={bar().x > width * 0.62 ? "left" : "right"}
            style={getUsageTooltipStyle(bar().x, bar().width, width)}
          >
            <strong>{bar().point.date}</strong>
            <span>{formatTokens(usageTotal(bar().point))} total</span>
            <div data-slot="tooltip-divider" />
            <For each={bar().point.segments}>
              {(segment, index) => (
                <p data-active={activeSegment() === index() ? "true" : undefined}>
                  <span data-slot="tooltip-label">
                    <i style={{ background: usageColors[index()] }} /> {segment.model}
                  </span>
                  <b>{formatTokens(segment.value)}</b>
                </p>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  )
}

function getUsageData(product: UsageProduct, range: UsageRange) {
  return usageDates[range].map((date, dayIndex) => ({
    date,
    segments: (usageValues[(dayIndex + ranges.indexOf(range)) % usageValues.length] ?? []).map(
      (value, segmentIndex) => ({
        model: usageModels[segmentIndex] ?? "Other",
        value: Number(
          (
            value *
            usageProductMultipliers[product] *
            usageRangeMultipliers[range] *
            (1 + (((dayIndex + segmentIndex + products.indexOf(product) + ranges.indexOf(range)) % 5) - 2) * 0.055)
          ).toFixed(2),
        ),
      }),
    ),
  }))
}

function getUsageTooltipStyle(barX: number, barWidth: number, width: number) {
  if (barX > width * 0.62) return { left: "auto", right: `${((width - barX + 12) / width) * 100}%` }
  return { left: `${((barX + barWidth + 12) / width) * 100}%`, right: "auto" }
}

function getUsageSegmentOpacity(isActiveBar: boolean, activeSegment: number | undefined, index: number) {
  if (!isActiveBar) return 1
  if (activeSegment === undefined) return 1
  return activeSegment === index ? 1 : 0.38
}

function usageTotal(point: UsagePoint) {
  return point.segments.reduce((sum, item) => sum + item.value, 0)
}

function formatTokens(value: number) {
  if (value >= 1) return `${value.toFixed(value >= 10 ? 0 : 1)}T`
  return `${Math.round(value * 1000)}B`
}

function LeaderboardSection() {
  const [product, setProduct] = createSignal<UsageProduct>("All Users")
  const [range, setRange] = createSignal<UsageRange>("1W")
  const data = createMemo(() => getLeaderboardData(product(), range()))

  return (
    <ChartSection
      title="Leaderboard"
      description="Shown are the sum of prompt and completion tokens per model, including reasoning tokens."
    >
      <Leaderboard data={data()} />
      <div data-slot="chart-footer">
        <RankingFilters product={product()} range={range()} onProductSelect={setProduct} onRangeSelect={setRange} />
      </div>
    </ChartSection>
  )
}

function Leaderboard(props: { data: (LeaderboardEntry & { rank: number })[] }) {
  return (
    <div data-component="leaderboard" aria-label="Model token leaderboard">
      <div data-slot="leaderboard-grid">
        <div data-slot="leaderboard-featured">
          <For each={props.data.slice(0, 3)}>{(entry) => <LeaderboardCard entry={entry} size="featured" />}</For>
        </div>
        <div data-slot="leaderboard-compact">
          <For each={props.data.slice(3)}>{(entry) => <LeaderboardCard entry={entry} size="compact" />}</For>
        </div>
      </div>
    </div>
  )
}

function LeaderboardCard(props: { entry: LeaderboardEntry & { rank: number }; size: "featured" | "compact" }) {
  return (
    <article data-component="leader-card" data-size={props.size}>
      <span data-slot="rank">{String(props.entry.rank).padStart(2, "0")}</span>
      <ProviderIcon data-slot="leader-watermark" aria-hidden="true" id={getProviderIconId(props.entry.author)} />
      <div data-slot="leader-body">
        <ProviderIcon data-slot="leader-avatar" aria-hidden="true" id={getProviderIconId(props.entry.author)} />
        <div data-slot="leader-copy">
          <div>
            <strong>{props.entry.model}</strong>
            <span>{formatBillions(props.entry.tokens)}</span>
          </div>
          <div>
            <span>{props.entry.author}</span>
            <span data-slot="delta" data-negative={props.entry.change < 0 ? "true" : undefined}>
              {formatChange(props.entry.change)}
            </span>
          </div>
        </div>
      </div>
    </article>
  )
}

function getLeaderboardData(product: UsageProduct, range: UsageRange) {
  return leaderboard
    .filter((entry) => entry.products.includes(product))
    .map((entry, index) => ({
      ...entry,
      tokens: Math.round(entry.tokens * usageProductMultipliers[product] * usageRangeMultipliers[range]),
      change: entry.change + (((index + products.indexOf(product) + ranges.indexOf(range)) % 5) - 2),
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .map((entry, index) => ({ ...entry, rank: index + 1 }))
}

function getProviderIconId(author: string) {
  if (author === "MiniMax") return "minimax"
  if (author === "Moonshot") return "moonshotai"
  if (author === "Zhipu") return "zhipuai"
  return author.toLowerCase()
}

function formatBillions(value: number) {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}T`
  return `${value}B`
}

function formatChange(value: number) {
  if (value > 0) return `+${value}%`
  return `${value}%`
}

function MarketShareSection() {
  const [range, setRange] = createSignal<UsageRange>("1W")
  const [activeIndex, setActiveIndex] = createSignal(2)
  const data = createMemo(() => getMarketData(range()))
  const activeDay = createMemo(() => data()[activeIndex()] ?? data()[0])

  return (
    <ChartSection title="Market Share" description="Compare token share by model author.">
      <MarketShare data={data()} activeIndex={activeIndex()} onActiveIndexChange={setActiveIndex} />
      <MarketShareList data={activeDay().authors} />
      <div data-slot="market-footer">
        <p>
          <span>[*]</span>
          <strong>{activeDay().date} 2026</strong>
        </p>
        <FilterPills items={ranges} selected={range()} label="Date range" variant="range" onSelect={setRange} />
      </div>
    </ChartSection>
  )
}

function MarketShare(props: { data: MarketDay[]; activeIndex: number; onActiveIndexChange: (index: number) => void }) {
  return (
    <div data-component="market-share" role="img" aria-label="Market share by model author">
      <div data-slot="market-labels">
        <For each={props.data}>
          {(day, index) => (
            <button
              type="button"
              data-active={props.activeIndex === index() ? "true" : undefined}
              onClick={() => props.onActiveIndexChange(index())}
            >
              <span>{formatTrillions(day.total)}</span>
              <span>{day.date}</span>
            </button>
          )}
        </For>
      </div>
      <div data-slot="market-bars">
        <For each={props.data}>
          {(day, index) => (
            <button
              type="button"
              aria-label={`${day.date} ${formatTrillions(day.total)}`}
              data-active={props.activeIndex === index() ? "true" : undefined}
              onClick={() => props.onActiveIndexChange(index())}
            >
              <For each={day.authors}>
                {(author, authorIndex) => (
                  <span
                    style={{
                      "background-color": props.activeIndex === index() ? marketColors[authorIndex()] : undefined,
                      "flex-grow": author.share,
                    }}
                  />
                )}
              </For>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

function MarketShareList(props: { data: MarketDay["authors"] }) {
  return (
    <ol data-component="market-share-list">
      <For each={props.data}>
        {(item, index) => (
          <li>
            <span>{String(index() + 1).padStart(2, "0")}</span>
            <i style={{ background: marketColors[index()] }} />
            <strong>{item.author}</strong>
            <em>{formatTrillions(item.tokens)}</em>
            <b>{item.share.toFixed(1)}%</b>
          </li>
        )}
      </For>
    </ol>
  )
}

function getMarketData(range: UsageRange) {
  return usageDates[range].map((date, dayIndex) => {
    const authors = market.map((item, authorIndex) => ({
      author: item.author,
      share: Number(
        Math.max(
          1.2,
          item.values[dayIndex] + (((dayIndex + authorIndex + ranges.indexOf(range)) % 5) - 2) * 0.4,
        ).toFixed(1),
      ),
      tokens: 0,
    }))
    const totalShare = authors.reduce((sum, item) => sum + item.share, 0)
    return {
      date,
      total: marketTotals[range][dayIndex] ?? 0,
      authors: authors.map((item) => ({
        ...item,
        share: Number(((item.share / totalShare) * 100).toFixed(1)),
        tokens: Number((((marketTotals[range][dayIndex] ?? 0) * item.share) / totalShare).toFixed(2)),
      })),
    }
  })
}

function formatTrillions(value: number) {
  return `${value.toFixed(value >= 10 ? 0 : 1)}T`
}

function TokenCostSection() {
  const [product, setProduct] = createSignal<TokenProduct>("Zen")
  const [live, setLive] = createSignal(true)
  const [activeIndex, setActiveIndex] = createSignal(2)
  const data = createMemo(() => getTokenCostData(product(), live()))

  return (
    <ChartSection title="Token Cost" description="Price per 1M tokens.">
      <TokenCostChart data={data()} activeIndex={activeIndex()} onActiveIndexChange={setActiveIndex} />
      <div data-slot="token-footer">
        <FilterPills
          items={tokenProducts}
          selected={product()}
          label="Product filter"
          variant="product"
          onSelect={setProduct}
        />
        <button
          type="button"
          data-component="live-filter"
          data-active={live() ? "true" : undefined}
          onClick={() => setLive(!live())}
        >
          Live
        </button>
      </div>
    </ChartSection>
  )
}

function TokenCostChart(props: {
  data: ReturnType<typeof getTokenCostData>
  activeIndex: number
  onActiveIndexChange: (index: number) => void
}) {
  const max = createMemo(() => Math.max(...props.data.map((item) => item.total)))
  const active = createMemo(() => props.data[props.activeIndex] ?? props.data[0])

  return (
    <div data-component="token-cost">
      <For each={props.data}>
        {(item, index) => (
          <button
            type="button"
            data-component="token-row"
            data-active={props.activeIndex === index() ? "true" : undefined}
            onClick={() => props.onActiveIndexChange(index())}
            onPointerEnter={() => props.onActiveIndexChange(index())}
          >
            <strong>{formatDollars(item.total)}</strong>
            <span>{item.model}</span>
            <MetricBar value={item.total} max={max()} active={props.activeIndex === index()} />
          </button>
        )}
      </For>
      <Show when={active()}>
        {(item) => (
          <div data-component="token-tooltip" style={{ top: `${props.activeIndex * 28 + 2}px` }}>
            <p>
              <span>Input</span>
              <strong>{formatDollars(item().input)}</strong>
            </p>
            <p>
              <span>Output</span>
              <strong>{formatDollars(item().output)}</strong>
            </p>
            <p>
              <span>Cached</span>
              <strong>{formatDollars(item().cached)}</strong>
            </p>
          </div>
        )}
      </Show>
    </div>
  )
}

function getTokenCostData(product: TokenProduct, live: boolean) {
  return tokenCosts.map((item, index) => {
    const multiplier = (product === "Zen" ? 1 : product === "Go" ? 0.88 : 1.18) * (live ? 1 : 0.94)
    const total = Number((item[1] * multiplier).toFixed(2))
    return {
      model: item[0],
      total,
      input: Number((total * (index < 3 ? 0.18 : 0.22)).toFixed(2)),
      output: Number((total * (index < 3 ? 1.1 : 1.34)).toFixed(2)),
      cached: Number((total * 0.1).toFixed(2)),
    }
  })
}

function formatDollars(value: number) {
  return `$${value.toFixed(2)}`
}

function MetricBar(props: { value: number; max: number; active: boolean }) {
  return (
    <i data-component="metric-bar" data-active={props.active ? "true" : undefined}>
      <b style={{ "flex-grow": Math.max(props.value / props.max, 0.05) }} />
      <em />
    </i>
  )
}

function SessionCostSection() {
  const [product, setProduct] = createSignal<TokenProduct>("Zen")
  const [live, setLive] = createSignal(true)
  const [activeIndex, setActiveIndex] = createSignal(2)
  const data = createMemo(() => getSessionCostData(product(), live()))

  return (
    <ChartSection title="Session Cost" description="Average cost per session.">
      <SessionCostChart data={data()} activeIndex={activeIndex()} onActiveIndexChange={setActiveIndex} />
      <div data-slot="token-footer">
        <FilterPills
          items={tokenProducts}
          selected={product()}
          label="Product filter"
          variant="product"
          onSelect={setProduct}
        />
        <button
          type="button"
          data-component="live-filter"
          data-active={live() ? "true" : undefined}
          onClick={() => setLive(!live())}
        >
          Live
        </button>
      </div>
    </ChartSection>
  )
}

function SessionCostChart(props: {
  data: ReturnType<typeof getSessionCostData>
  activeIndex: number
  onActiveIndexChange: (index: number) => void
}) {
  const maxCost = createMemo(() => Math.max(...props.data.map((item) => item.cost)))
  const maxTokens = createMemo(() => Math.max(...props.data.map((item) => item.tokens)))
  const active = createMemo(() => props.data[props.activeIndex] ?? props.data[0])

  return (
    <div data-component="session-cost">
      <div data-slot="session-heading">
        <span />
        <p>COST / SESSION</p>
        <p>TOKENS / SESSIONS</p>
      </div>
      <For each={props.data}>
        {(item, index) => (
          <button
            type="button"
            data-component="token-row"
            data-variant="session"
            data-active={props.activeIndex === index() ? "true" : undefined}
            onClick={() => props.onActiveIndexChange(index())}
            onPointerEnter={() => props.onActiveIndexChange(index())}
          >
            <strong>{formatSessionCost(item.cost)}</strong>
            <span>{item.model}</span>
            <MetricBar value={item.cost} max={maxCost()} active={props.activeIndex === index()} />
            <MetricBar value={item.tokens} max={maxTokens()} active={props.activeIndex === index()} />
          </button>
        )}
      </For>
      <Show when={active()}>
        {(item) => (
          <div
            data-component="token-tooltip"
            data-variant="session"
            style={{ top: `${props.activeIndex * 28 + 21}px` }}
          >
            <p>
              <span>Cost/Session</span>
              <strong>{formatSessionCost(item().cost)}</strong>
            </p>
            <p>
              <span>Tokens/Session</span>
              <strong>{formatTokenCount(item().tokens)}</strong>
            </p>
          </div>
        )}
      </Show>
    </div>
  )
}

function getSessionCostData(product: TokenProduct, live: boolean) {
  return sessionCosts.map((item) => {
    const multiplier = (product === "Zen" ? 1 : product === "Go" ? 0.9 : 1.2) * (live ? 1 : 0.94)
    return {
      model: item[0],
      cost: Number((item[1] * multiplier).toFixed(4)),
      tokens: Math.round(parseTokenCount(item[2]) * (product === "Enterprise" ? 1.12 : product === "Go" ? 0.92 : 1)),
    }
  })
}

function parseTokenCount(value: string) {
  if (value.endsWith("M")) return Number(value.slice(0, -1)) * 1_000_000
  return Number(value.slice(0, -1)) * 1_000
}

function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  return `${Math.round(value / 1_000)}K`
}

function formatSessionCost(value: number) {
  return `$${value.toFixed(4)}`
}

function CountryMap() {
  return (
    <div data-component="country-map">
      <svg viewBox="0 0 920 420" role="img" aria-label="Tokens by country map">
        <defs>
          <pattern id="rankings-dot-grid" width="18" height="18" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.5" fill="#d4d4d4" />
          </pattern>
        </defs>
        <rect width="920" height="420" fill="url(#rankings-dot-grid)" />
        <For each={countries}>
          {(item) => (
            <g>
              <circle cx={(item[2] / 100) * 920} cy={(item[3] / 100) * 420} r={item[4]} />
              <text x={(item[2] / 100) * 920 + item[4] + 8} y={(item[3] / 100) * 420 + 4}>
                {item[0]} {item[1]}
              </text>
            </g>
          )}
        </For>
      </svg>
      <div data-component="map-tooltip">
        <strong>Canada</strong>
        <span>130B</span>
      </div>
    </div>
  )
}

function Newsletter() {
  return (
    <section data-section="newsletter">
      <div>
        <h2>Be the first to know when we release new products</h2>
        <p>Join the waitlist for early access.</p>
      </div>
      <form>
        <input type="email" placeholder="Email address" />
        <button>Subscribe</button>
      </form>
    </section>
  )
}

function Header() {
  return (
    <section data-component="top">
      <a data-slot="wordmark" href="/">
        opencode
      </a>
      <nav data-component="nav-desktop" aria-label="Main navigation">
        <ul>
          <li>
            <a href="https://github.com/sst/opencode" target="_blank">
              GitHub
            </a>
          </li>
          <li>
            <a href="https://opencode.ai/docs">Docs</a>
          </li>
          <li>
            <a href="/rankings">Rankings</a>
          </li>
        </ul>
      </nav>
    </section>
  )
}

function Footer() {
  return (
    <footer data-component="footer">
      <div data-slot="cell">
        <a href="https://github.com/sst/opencode" target="_blank">
          GitHub
        </a>
      </div>
      <div data-slot="cell">
        <a href="https://opencode.ai/docs">Docs</a>
      </div>
      <div data-slot="cell">
        <a href="https://opencode.ai/changelog">Changelog</a>
      </div>
      <div data-slot="cell">
        <a href="https://x.com/opencode_ai">X</a>
      </div>
    </footer>
  )
}

function Legal() {
  return (
    <div data-component="legal">
      <span>
        ©{new Date().getFullYear()} <a href="https://anoma.ly">Anomaly</a>
      </span>
      <span>
        <a href="https://opencode.ai/brand">Brand</a>
      </span>
      <span>
        <a href="https://opencode.ai/legal/privacy-policy">Privacy</a>
      </span>
      <span>
        <a href="https://opencode.ai/legal/terms-of-service">Terms</a>
      </span>
    </div>
  )
}
