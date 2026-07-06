export interface GeoHit {
  name: string
  latitude: number
  longitude: number
  admin1?: string
  country?: string
}

export interface CurrentWeather {
  temperature: number
  apparentTemperature: number
  humidity: number
  weatherCode: number
  windSpeed: number
}

export interface DailyWeather {
  date: string
  weatherCode: number
  tempMax: number
  tempMin: number
  precipProbability: number
}

export interface ForecastData {
  current: CurrentWeather
  daily: DailyWeather[]
}

// WMO weather code(0–99)→ 中文天气现象。天气码语义变动时此表是唯一改动点。
const WMO_TEXT: Record<number, string> = {
  0: '晴', 1: '大部晴朗', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨', 56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨', 85: '小阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹'
}

export function wmoCodeText(code: number): string {
  return WMO_TEXT[code] ?? `未知(code ${code})`
}

export function parseGeocoding(json: unknown): GeoHit[] {
  const results = (json as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) return []
  return results
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => ({
      name: String(r.name ?? ''),
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      admin1: r.admin1 != null ? String(r.admin1) : undefined,
      country: r.country != null ? String(r.country) : undefined
    }))
    .filter((h) => h.name !== '' && Number.isFinite(h.latitude) && Number.isFinite(h.longitude))
}

export function parseForecast(json: unknown): ForecastData {
  const o = (json ?? {}) as { current?: Record<string, unknown>; daily?: Record<string, unknown> }
  const cur = o.current ?? {}
  const current: CurrentWeather = {
    temperature: Number(cur.temperature_2m),
    apparentTemperature: Number(cur.apparent_temperature),
    humidity: Number(cur.relative_humidity_2m),
    weatherCode: Number(cur.weather_code),
    windSpeed: Number(cur.wind_speed_10m)
  }
  const d = o.daily ?? {}
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  const times = arr(d.time)
  const codes = arr(d.weather_code)
  const maxs = arr(d.temperature_2m_max)
  const mins = arr(d.temperature_2m_min)
  const pops = arr(d.precipitation_probability_max)
  const daily: DailyWeather[] = times.map((t, i) => ({
    date: String(t),
    weatherCode: Number(codes[i]),
    tempMax: Number(maxs[i]),
    tempMin: Number(mins[i]),
    precipProbability: Number(pops[i])
  }))
  return { current, daily }
}

export function formatWeather(loc: GeoHit, data: ForecastData): string {
  const place = [loc.name, loc.admin1, loc.country].filter((s) => s && s.length > 0).join('·')
  const c = data.current
  const head =
    `${place} 天气\n\n` +
    `当前:${wmoCodeText(c.weatherCode)} ${c.temperature}°C(体感 ${c.apparentTemperature}°C) ` +
    `湿度 ${c.humidity}% 风速 ${c.windSpeed} km/h`
  const rows = data.daily.slice(1, 4).map((d) =>
    `${d.date.slice(5)} ${wmoCodeText(d.weatherCode)} ${d.tempMin}~${d.tempMax}°C 降水概率 ${d.precipProbability}%`
  )
  return `${head}\n\n未来3天:\n${rows.join('\n')}`
}
