export interface BookSummary {
  id: string;
  title: string;
  author: string;
  section_count: number;
}

export interface SectionSummary {
  id: string;
  title: string;
  position: number;
  spine_position: number;
}

export interface BookDetail extends BookSummary {
  sections: SectionSummary[];
}

export interface TextBlock {
  id: string;
  position: number;
  kind: 'heading' | 'paragraph';
  heading_level: number | null;
  text: string;
}

export interface SectionDetail extends SectionSummary {
  blocks: TextBlock[];
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, options);
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body.detail === 'string') message = body.detail;
    } catch { /* A proxy error may not contain JSON. */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function errorMessage(error: unknown): string {
  return error instanceof TypeError
    ? 'Cannot reach the server. Check that the backend is running and try again.'
    : error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
