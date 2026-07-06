import { describe, it, expect } from 'vitest'
import {
  wmoCodeText,
  parseGeocoding,
  parseForecast,
  formatWeather,
  createOpenMeteoClient,
  type GeoHit,
  type ForecastData
} from './weather'

// Open-Meteo 地理编码响应样本(/v1/search?name=北京&count=1&language=zh)
const geoJson = {
  results: [
    { id: 1, name: '北京', latitude: 39.9075, longitude: 116.39723, admin1: '北京市', country: '中国' }
  ],
  generationtime_ms: 0.3
}

// 无命中:Open-Meteo 返回不带 results 键
const geoEmptyJson = { generationtime_ms: 0.2 }

// Open-Meteo 预报响应样本(forecast_days=4:今天 + 未来3天)
const forecastJson = {
  timezone: 'Asia/Shanghai',
  current: {
    time: '2026-07-06T14:00',
    temperature_2m: 30.5,
    apparent_temperature: 33.1,
    relative_humidity_2m: 55,
    weather_code: 2,
    wind_speed_10m: 12.4
  },
  daily: {
    time: ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09'],
    weather_code: [2, 63, 3, 0],
    temperature_2m_max: [31, 28, 30, 33],
    temperature_2m_min: [22, 21, 20, 24],
    precipitation_probability_max: [10, 80, 30, 0]
  }
}

describe('wmoCodeText', () => {
  it('已知码映射到中文现象', () => {
    expect(wmoCodeText(0)).toBe('晴')
    expect(wmoCodeText(2)).toBe('多云')
    expect(wmoCodeText(63)).toBe('中雨')
    expect(wmoCodeText(95)).toBe('雷阵雨')
  })
  it('未知码退化为「未知(code N)」', () => {
    expect(wmoCodeText(42)).toBe('未知(code 42)')
  })
})

describe('parseGeocoding', () => {
  it('取出命中项的名称/经纬度/行政区/国家', () => {
    const hits = parseGeocoding(geoJson)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toEqual({
      name: '北京', latitude: 39.9075, longitude: 116.39723, admin1: '北京市', country: '中国'
    })
  })
  it('无 results 键退化为空数组', () => {
    expect(parseGeocoding(geoEmptyJson)).toEqual([])
    expect(parseGeocoding({})).toEqual([])
    expect(parseGeocoding(null)).toEqual([])
  })
})

describe('parseForecast', () => {
  it('取出当前实况与每日数组', () => {
    const data = parseForecast(forecastJson)
    expect(data.current).toEqual({
      temperature: 30.5, apparentTemperature: 33.1, humidity: 55, weatherCode: 2, windSpeed: 12.4
    })
    expect(data.daily).toHaveLength(4)
    expect(data.daily[1]).toEqual({
      date: '2026-07-07', weatherCode: 63, tempMax: 28, tempMin: 21, precipProbability: 80
    })
  })
})

describe('formatWeather', () => {
  it('含地点、当前实况、未来3天(取 daily[1..3])', () => {
    const loc: GeoHit = geoJson.results[0]
    const data: ForecastData = parseForecast(forecastJson)
    const text = formatWeather(loc, data)
    expect(text).toContain('北京·北京市·中国')
    expect(text).toContain('多云 30.5°C(体感 33.1°C)')
    expect(text).toContain('湿度 55%')
    expect(text).toContain('未来3天')
    // 未来3天从明天起(daily[1..3]),不含今天(07-06)
    expect(text).toContain('07-07 中雨 21~28°C 降水概率 80%')
    expect(text).toContain('07-09 晴 24~33°C 降水概率 0%')
    expect(text).not.toContain('07-06')
  })
})

describe('createOpenMeteoClient', () => {
  const signal = new AbortController().signal
  // 按 URL 路由的假 fetch:含 'geocoding' 走地理编码,否则走预报
  const routed = (geo: unknown, forecast: unknown, geoStatus = 200, fStatus = 200): typeof fetch =>
    (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('geocoding')) return new Response(JSON.stringify(geo), { status: geoStatus })
      return new Response(JSON.stringify(forecast), { status: fStatus })
    }) as typeof fetch

  it('happy-path:地理编码 URL 带 name/language/count,预报 URL 带经纬度与 forecast_days=4,返回 loc+data', async () => {
    const urls: string[] = []
    const fetchFn: typeof fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      urls.push(u)
      if (u.includes('geocoding')) return new Response(JSON.stringify(geoJson), { status: 200 })
      return new Response(JSON.stringify(forecastJson), { status: 200 })
    }) as typeof fetch
    const res = await createOpenMeteoClient(fetchFn).getWeather('北京', signal)
    expect(res).not.toBeNull()
    expect(res!.loc.name).toBe('北京')
    expect(res!.data.daily).toHaveLength(4)
    expect(urls[0]).toContain('geocoding-api.open-meteo.com/v1/search')
    expect(urls[0]).toContain('name=%E5%8C%97%E4%BA%AC') // encodeURIComponent('北京')
    expect(urls[0]).toContain('language=zh')
    expect(urls[0]).toContain('count=1')
    expect(urls[1]).toContain('api.open-meteo.com/v1/forecast')
    expect(urls[1]).toContain('latitude=39.9075')
    expect(urls[1]).toContain('longitude=116.39723')
    expect(urls[1]).toContain('forecast_days=4')
  })

  it('地名无命中返回 null(不请求预报)', async () => {
    let forecastCalled = false
    const fetchFn: typeof fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('geocoding')) return new Response(JSON.stringify(geoEmptyJson), { status: 200 })
      forecastCalled = true
      return new Response(JSON.stringify(forecastJson), { status: 200 })
    }) as typeof fetch
    const res = await createOpenMeteoClient(fetchFn).getWeather('不存在的地方xyz', signal)
    expect(res).toBeNull()
    expect(forecastCalled).toBe(false)
  })

  it('地理编码 HTTP 非 2xx 抛人话错误', async () => {
    await expect(createOpenMeteoClient(routed(geoJson, forecastJson, 500)).getWeather('北京', signal))
      .rejects.toThrow(/500/)
  })

  it('预报 HTTP 非 2xx 抛人话错误', async () => {
    await expect(createOpenMeteoClient(routed(geoJson, forecastJson, 200, 503)).getWeather('北京', signal))
      .rejects.toThrow(/503/)
  })
})
