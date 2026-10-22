import axios, { type AxiosAdapter } from 'axios'

/** SDK HttpInstance 返回正文，特定下载接口另要求响应头；独立实例不修改旧服务全局拦截器。 */
export const createFeishuHttp = (options: { adapter?: AxiosAdapter } = {}) => {
  const http = axios.create({ timeout: 15_000, maxRedirects: 0, ...options })
  http.interceptors.response.use((response) => {
    if ('$return_headers' in response.config && response.config.$return_headers)
      return { data: response.data, headers: response.headers }
    return response.data
  })
  return http
}
