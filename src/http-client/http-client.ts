export interface HttpClient {
  init(baseURL?: string, defaultOptions?: RequestInit): HttpClient;
  get<T = unknown>(url: string, options?: RequestInit): Promise<T>;
  post<T = unknown>(
    url: string,
    body?: unknown,
    options?: RequestInit
  ): Promise<T>;
  put<T = unknown>(
    url: string,
    body?: unknown,
    options?: RequestInit
  ): Promise<T>;
  patch<T = unknown>(
    url: string,
    body?: unknown,
    options?: RequestInit
  ): Promise<T>;
  delete<T = unknown>(url: string, options?: RequestInit): Promise<T>;
}

export class FetchHttpClient implements HttpClient {
  constructor(
    private readonly baseURL?: string,
    private readonly defaultOptions?: RequestInit
  ) {}

  init(baseURL?: string, defaultOptions?: RequestInit) {
    return new FetchHttpClient(baseURL, defaultOptions);
  }

  private async request<T>(url: string, options: RequestInit = {}): Promise<T> {
    const fullUrl = this.baseURL ? new URL(url, this.baseURL).toString() : url;

    const response = await fetch(fullUrl, {
      ...this.defaultOptions,
      ...options,
      headers: {
        ...this.defaultOptions?.headers,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = new Error(`HTTP error! status: ${response.status}`);
      // Attach response body to error for error handling
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        (error as unknown as { response: unknown }).response =
          await response.json();
      } else {
        (error as unknown as { response: unknown }).response =
          await response.text();
      }
      throw error;
    }

    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      return response.json() as Promise<T>;
    }

    return response.text() as Promise<T>;
  }

  async get<T = unknown>(url: string, options?: RequestInit): Promise<T> {
    return this.request<T>(url, { ...options, method: "GET" });
  }

  async post<T = unknown>(
    url: string,
    body?: unknown,
    options?: RequestInit
  ): Promise<T> {
    return this.request<T>(url, {
      ...options,
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
  }

  async put<T = unknown>(
    url: string,
    body?: unknown,
    options?: RequestInit
  ): Promise<T> {
    return this.request<T>(url, {
      ...options,
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
  }

  async patch<T = unknown>(
    url: string,
    body?: unknown,
    options?: RequestInit
  ): Promise<T> {
    return this.request<T>(url, {
      ...options,
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
  }

  async delete<T = unknown>(url: string, options?: RequestInit): Promise<T> {
    return this.request<T>(url, { ...options, method: "DELETE" });
  }
}
