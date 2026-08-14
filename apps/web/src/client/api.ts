import { ApiClient } from '@claude-team/protocol';

/**
 * The one client instance the browser uses.
 *
 * Nothing in this app builds a URL or calls `fetch` by hand: the route table
 * and the payload shapes live in `@claude-team/protocol`, so an endpoint that
 * changes shape is a compile error here rather than a runtime surprise.
 */
export const client = new ApiClient();

export { ApiError } from '@claude-team/protocol';
