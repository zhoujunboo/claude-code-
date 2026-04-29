export interface GitHubRepoInfo {
  stars: number;
  forks: number;
  description: string | null;
}

export interface GitHubApiOptions {
  token?: string;
  timeout?: number;
}

export async function getGitHubRepoInfo(
  owner: string,
  repo: string,
  options: GitHubApiOptions = {}
): Promise<GitHubRepoInfo> {
  const { token, timeout = 10000 } = options;
  const url = `https://api.github.com/repos/${owner}/${repo}`;

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'GitHub-API-Client'
  };

  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    return {
      stars: data.stargazers_count || 0,
      forks: data.forks_count || 0,
      description: data.description || null
    };
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}