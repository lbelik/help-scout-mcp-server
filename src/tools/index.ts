import { Tool, CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PaginatedResponse, helpScoutClient } from '../utils/helpscout-client.js';
import { createMcpToolError, isApiError } from '../utils/mcp-errors.js';
import { HelpScoutAPIConstraints, ToolCallContext } from '../utils/api-constraints.js';
import { logger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { stripHtml, stripQuotedContent } from '../utils/html-stripper.js';
import { z } from 'zod';

/**
 * Constants for tool operations
 */
const TOOL_CONSTANTS = {
  // API pagination defaults
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 100,
  MAX_THREAD_SIZE: 200,
  DEFAULT_THREAD_SIZE: 200,
  
  // Search limits
  MAX_SEARCH_TERMS: 10,
  DEFAULT_TIMEFRAME_DAYS: 60,
  DEFAULT_LIMIT_PER_STATUS: 25,
  
  // Sort configuration
  DEFAULT_SORT_FIELD: 'createdAt',
  DEFAULT_SORT_ORDER: 'desc',
  
  // Cache and performance
  MAX_CONVERSATION_ID_LENGTH: 20,
  
  // Search locations
  SEARCH_LOCATIONS: {
    BODY: 'body',
    SUBJECT: 'subject', 
    BOTH: 'both'
  } as const,
  
  // Conversation statuses
  STATUSES: {
    ACTIVE: 'active',
    PENDING: 'pending',
    CLOSED: 'closed',
    SPAM: 'spam'
  } as const
} as const;
import {
  Inbox,
  Conversation,
  Thread,
  ServerTime,
  SearchInboxesInputSchema,
  SearchConversationsInputSchema,
  GetThreadsInputSchema,
  GetConversationSummaryInputSchema,
  AdvancedConversationSearchInputSchema,
  MultiStatusConversationSearchInputSchema,
  StructuredConversationFilterInputSchema,
  ListUsersInputSchema,
  GetCompanyReportInputSchema,
  GetUserReportInputSchema,
  GetProductivityReportInputSchema,
  GetAttachmentsInputSchema,
  GetAttachmentDataInputSchema,
} from '../schema/types.js';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export class ToolHandler {
  private callHistory: string[] = [];
  private currentUserQuery?: string;

  constructor() {
    // Direct imports, no DI needed
  }

  /**
   * Escape special characters in Help Scout query syntax to prevent injection
   * Help Scout uses double quotes for exact phrases, so we need to escape them
   */
  private escapeQueryTerm(term: string): string {
    // Escape backslashes first, then double quotes
    return term.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * Append a createdAt date range to an existing Help Scout query string.
   * Help Scout has no native createdAfter/createdBefore URL params, so we
   * use query syntax: (createdAt:[start TO end]).
   */
  private appendCreatedAtFilter(
    existingQuery: string | undefined,
    createdAfter?: string,
    createdBefore?: string
  ): string | undefined {
    if (!createdAfter && !createdBefore) return existingQuery;

    // Validate date format to prevent query injection and match Help Scout expectations
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
    if (createdAfter && !isoDatePattern.test(createdAfter)) {
      throw new Error(`Invalid createdAfter date format: ${createdAfter}. Expected ISO 8601 (e.g., 2024-01-15T00:00:00Z)`);
    }
    if (createdBefore && !isoDatePattern.test(createdBefore)) {
      throw new Error(`Invalid createdBefore date format: ${createdBefore}. Expected ISO 8601 (e.g., 2024-01-15T00:00:00Z)`);
    }

    // Strip milliseconds (Help Scout rejects .xxx format)
    const normalize = (d: string) => d.replace(/\.\d{3}Z$/, 'Z');
    const start = createdAfter ? normalize(createdAfter) : '*';
    const end = createdBefore ? normalize(createdBefore) : '*';
    const clause = `(createdAt:[${start} TO ${end}])`;

    if (!existingQuery) return clause;
    return `(${existingQuery}) AND ${clause}`;
  }

  /**
   * Set the current user query for context-aware validation
   */
  setUserContext(userQuery: string): void {
    this.currentUserQuery = userQuery;
  }

  async listTools(): Promise<Tool[]> {
    return [
      {
        name: 'searchInboxes',
        description: 'List or search inboxes by name. Deprecated: inbox IDs now in server instructions. Only needed to refresh list mid-session.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query to match inbox names. Use empty string "" to list ALL inboxes. This is case-insensitive substring matching.',
            },
            limit: {
              type: 'number',
              description: `Maximum number of results (1-${TOOL_CONSTANTS.MAX_PAGE_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_PAGE_SIZE,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'searchConversations',
        description: 'List conversations by status, date range, inbox, or tags. Searches all statuses by default. For keyword content search, use comprehensiveConversationSearch.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'HelpScout query syntax. Omit to list all. Example: (body:"keyword")',
            },
            inboxId: {
              type: 'string',
              description: 'Inbox ID from server instructions',
            },
            tag: {
              type: 'string',
              description: 'Filter by tag name',
            },
            status: {
              type: 'string',
              enum: [TOOL_CONSTANTS.STATUSES.ACTIVE, TOOL_CONSTANTS.STATUSES.PENDING, TOOL_CONSTANTS.STATUSES.CLOSED, TOOL_CONSTANTS.STATUSES.SPAM],
              description: 'Filter by status. Defaults to all (active, pending, closed)',
            },
            createdAfter: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created after this timestamp (ISO8601)',
            },
            createdBefore: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created before this timestamp (ISO8601)',
            },
            limit: {
              type: 'number',
              description: `Maximum number of results (1-${TOOL_CONSTANTS.MAX_PAGE_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_PAGE_SIZE,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
            sort: {
              type: 'string',
              enum: ['createdAt', 'updatedAt', 'number'],
              default: TOOL_CONSTANTS.DEFAULT_SORT_FIELD,
              description: 'Sort field',
            },
            order: {
              type: 'string',
              enum: ['asc', 'desc'],
              default: TOOL_CONSTANTS.DEFAULT_SORT_ORDER,
              description: 'Sort order',
            },
            fields: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific fields to return (for partial responses)',
            },
          },
        },
      },
      {
        name: 'getConversationSummary',
        description: 'Get conversation summary with first customer message and latest staff reply',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to get summary for',
            },
          },
          required: ['conversationId'],
        },
      },
      {
        name: 'getThreads',
        description: 'Retrieve full message history for a conversation. Returns all thread messages.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to get threads for',
            },
            limit: {
              type: 'number',
              description: `Maximum number of threads (1-${TOOL_CONSTANTS.MAX_THREAD_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_THREAD_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_THREAD_SIZE,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
          },
          required: ['conversationId'],
        },
      },
      {
        name: 'getServerTime',
        description: 'Get current server timestamp. Use before date-relative searches to calculate time ranges.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'listAllInboxes',
        description: 'List all inboxes with IDs. Deprecated: inbox IDs now in server instructions. Only needed mid-session.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of results (1-100)',
              minimum: 1,
              maximum: 100,
              default: 100,
            },
          },
        },
      },
      {
        name: 'advancedConversationSearch',
        description: 'Filter conversations by email domain, customer email, or multiple tags. Supports boolean logic for complex queries. For simple keyword search, use comprehensiveConversationSearch.',
        inputSchema: {
          type: 'object',
          properties: {
            contentTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Search terms to find in conversation body/content (will be OR combined)',
            },
            subjectTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Search terms to find in conversation subject (will be OR combined)',
            },
            customerEmail: {
              type: 'string',
              description: 'Exact customer email to search for',
            },
            emailDomain: {
              type: 'string',
              description: 'Email domain to search for (e.g., "company.com" to find all @company.com emails)',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tag names to search for (will be OR combined)',
            },
            inboxId: {
              type: 'string',
              description: 'Filter by inbox ID',
            },
            status: {
              type: 'string',
              enum: [TOOL_CONSTANTS.STATUSES.ACTIVE, TOOL_CONSTANTS.STATUSES.PENDING, TOOL_CONSTANTS.STATUSES.CLOSED, TOOL_CONSTANTS.STATUSES.SPAM],
              description: 'Filter by conversation status',
            },
            createdAfter: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created after this timestamp (ISO8601)',
            },
            createdBefore: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created before this timestamp (ISO8601)',
            },
            limit: {
              type: 'number',
              description: `Maximum number of results (1-${TOOL_CONSTANTS.MAX_PAGE_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_PAGE_SIZE,
            },
          },
        },
      },
      {
        name: 'comprehensiveConversationSearch',
        description: 'Search conversation content by keywords. Searches subject and body across all statuses. Requires searchTerms parameter. For listing without keywords, use searchConversations.',
        inputSchema: {
          type: 'object',
          properties: {
            searchTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keywords to search for (OR logic). Example: ["billing", "refund"]',
              minItems: 1,
            },
            inboxId: {
              type: 'string',
              description: 'Inbox ID from server instructions',
            },
            statuses: {
              type: 'array',
              items: { enum: ['active', 'pending', 'closed', 'spam'] },
              description: 'Conversation statuses to search (defaults to active, pending, closed)',
              default: ['active', 'pending', 'closed'],
            },
            searchIn: {
              type: 'array',
              items: { enum: ['body', 'subject', 'both'] },
              description: 'Where to search for terms (defaults to both body and subject)',
              default: ['both'],
            },
            timeframeDays: {
              type: 'number',
              description: `Number of days back to search (defaults to ${TOOL_CONSTANTS.DEFAULT_TIMEFRAME_DAYS})`,
              minimum: 1,
              maximum: 365,
              default: TOOL_CONSTANTS.DEFAULT_TIMEFRAME_DAYS,
            },
            createdAfter: {
              type: 'string',
              format: 'date-time',
              description: 'Override timeframeDays with specific start date (ISO8601)',
            },
            createdBefore: {
              type: 'string',
              format: 'date-time',
              description: 'End date for search range (ISO8601)',
            },
            limitPerStatus: {
              type: 'number',
              description: `Maximum results per status (defaults to ${TOOL_CONSTANTS.DEFAULT_LIMIT_PER_STATUS})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_LIMIT_PER_STATUS,
            },
            includeVariations: {
              type: 'boolean',
              description: 'Include common variations of search terms',
              default: true,
            },
          },
          required: ['searchTerms'],
        },
      },
      {
        name: 'structuredConversationFilter',
        description: 'Lookup conversation by ticket number or filter by assignee/customer/folder IDs. Use after discovering IDs from other searches. For initial searches, use searchConversations or comprehensiveConversationSearch.',
        inputSchema: {
          type: 'object',
          properties: {
            assignedTo: { type: 'number', description: 'User ID from previous_results[].assignee.id. Use -1 for unassigned.' },
            folderId: { type: 'number', description: 'Folder ID from Help Scout UI (not in API responses)' },
            customerIds: { type: 'array', items: { type: 'number' }, description: 'Customer IDs from previous_results[].customer.id' },
            conversationNumber: { type: 'number', description: 'Ticket number from previous_results[].number or user reference' },
            status: { type: 'string', enum: ['active', 'pending', 'closed', 'spam', 'all'], default: 'all' },
            inboxId: { type: 'string', description: 'Inbox ID to combine with filters' },
            tag: { type: 'string', description: 'Tag name to combine with filters' },
            createdAfter: { type: 'string', format: 'date-time' },
            createdBefore: { type: 'string', format: 'date-time' },
            modifiedSince: { type: 'string', format: 'date-time', description: 'Filter by last modified (different from created)' },
            sortBy: { type: 'string', enum: ['createdAt', 'modifiedAt', 'number', 'waitingSince', 'customerName', 'customerEmail', 'mailboxId', 'status', 'subject'], default: 'createdAt', description: 'waitingSince/customerName/customerEmail are unique to this tool' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
            limit: { type: 'number', minimum: 1, maximum: 100, default: 50 },
            cursor: { type: 'string' },
          },
        },
      },
      {
        name: 'listUsers',
        description: 'List Help Scout users (agents). Returns user IDs needed for per-agent reports. Filter by email or mailbox.',
        inputSchema: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Filter by email address' },
            mailbox: { type: 'number', description: 'Filter by mailbox ID — only return users with access to this mailbox' },
            page: { type: 'number', description: 'Page number (default 1)', minimum: 1, default: 1 },
          },
        },
      },
      {
        name: 'getCompanyReport',
        description: 'Get company-wide report with per-agent breakdown. Returns replies, customers helped, happiness scores for all agents in one call. Requires date range.',
        inputSchema: {
          type: 'object',
          properties: {
            start: { type: 'string', format: 'date-time', description: 'Start of date range (ISO 8601)' },
            end: { type: 'string', format: 'date-time', description: 'End of date range (ISO 8601)' },
            previousStart: { type: 'string', format: 'date-time', description: 'Start of previous period for comparison' },
            previousEnd: { type: 'string', format: 'date-time', description: 'End of previous period for comparison' },
            mailboxes: { type: 'string', description: 'Comma-separated mailbox IDs to filter by' },
            tags: { type: 'string', description: 'Comma-separated tag IDs to filter by' },
            types: { type: 'string', description: 'Comma-separated conversation types (email, chat, phone)' },
            folders: { type: 'string', description: 'Comma-separated folder IDs to filter by' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getUserReport',
        description: 'Get detailed report for a single agent. Returns response time, resolution time, handle time, happiness, and conversation counts. Requires user ID from listUsers.',
        inputSchema: {
          type: 'object',
          properties: {
            user: { type: 'number', description: 'User ID from listUsers results' },
            start: { type: 'string', format: 'date-time', description: 'Start of date range (ISO 8601)' },
            end: { type: 'string', format: 'date-time', description: 'End of date range (ISO 8601)' },
            previousStart: { type: 'string', format: 'date-time', description: 'Start of previous period for comparison' },
            previousEnd: { type: 'string', format: 'date-time', description: 'End of previous period for comparison' },
            mailboxes: { type: 'string', description: 'Comma-separated mailbox IDs to filter by' },
            tags: { type: 'string', description: 'Comma-separated tag IDs to filter by' },
            types: { type: 'string', description: 'Comma-separated conversation types (email, chat, phone)' },
            folders: { type: 'string', description: 'Comma-separated folder IDs to filter by' },
          },
          required: ['user', 'start', 'end'],
        },
      },
      {
        name: 'getProductivityReport',
        description: 'Get team-wide productivity metrics. Returns first response time, resolution time, handle time, replies per resolution. Requires date range.',
        inputSchema: {
          type: 'object',
          properties: {
            start: { type: 'string', format: 'date-time', description: 'Start of date range (ISO 8601)' },
            end: { type: 'string', format: 'date-time', description: 'End of date range (ISO 8601)' },
            previousStart: { type: 'string', format: 'date-time', description: 'Start of previous period for comparison' },
            previousEnd: { type: 'string', format: 'date-time', description: 'End of previous period for comparison' },
            mailboxes: { type: 'string', description: 'Comma-separated mailbox IDs to filter by' },
            tags: { type: 'string', description: 'Comma-separated tag IDs to filter by' },
            types: { type: 'string', description: 'Comma-separated conversation types (email, chat, phone)' },
            folders: { type: 'string', description: 'Comma-separated folder IDs to filter by' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getAttachments',
        description: 'List attachment metadata for a conversation. Returns filename, size, mimeType for each attachment across all threads. Use getAttachmentData to download a specific attachment.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to get attachments for',
            },
          },
          required: ['conversationId'],
        },
      },
      {
        name: 'getAttachmentData',
        description: 'Download a specific attachment. Images < 1MB are returned inline for visual inspection. Larger files or non-images are saved to a temp file path.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID',
            },
            attachmentId: {
              type: 'string',
              description: 'The attachment ID (from getAttachments results)',
            },
          },
          required: ['conversationId', 'attachmentId'],
        },
      },
    ];
  }

  async callTool(request: CallToolRequest): Promise<CallToolResult> {
    const requestId = Math.random().toString(36).substring(7);
    const startTime = Date.now();

    logger.info('Tool call started', {
      requestId,
      toolName: request.params.name,
      arguments: request.params.arguments,
    });

    // REVERSE LOGIC VALIDATION: Check API constraints before making the call
    const validationContext: ToolCallContext = {
      toolName: request.params.name,
      arguments: request.params.arguments || {},
      userQuery: this.currentUserQuery,
      previousCalls: [...this.callHistory]
    };

    const validation = HelpScoutAPIConstraints.validateToolCall(validationContext);
    
    if (!validation.isValid) {
      const errorDetails = {
        errors: validation.errors,
        suggestions: validation.suggestions,
        requiredPrerequisites: validation.requiredPrerequisites
      };
      
      logger.warn('Tool call validation failed', {
        requestId,
        toolName: request.params.name,
        validation: errorDetails
      });
      
      // Return helpful error with API constraint guidance
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'API Constraint Validation Failed',
            details: errorDetails,
            helpScoutAPIRequirements: {
              message: 'This call violates Help Scout API constraints',
              requiredActions: validation.requiredPrerequisites || [],
              suggestions: validation.suggestions
            }
          }, null, 2)
        }]
      };
    }

    try {
      let result: CallToolResult;

      switch (request.params.name) {
        case 'searchInboxes':
          result = await this.searchInboxes(request.params.arguments || {});
          break;
        case 'searchConversations':
          result = await this.searchConversations(request.params.arguments || {});
          break;
        case 'getConversationSummary':
          result = await this.getConversationSummary(request.params.arguments || {});
          break;
        case 'getThreads':
          result = await this.getThreads(request.params.arguments || {});
          break;
        case 'getServerTime':
          result = await this.getServerTime();
          break;
        case 'listAllInboxes':
          result = await this.listAllInboxes(request.params.arguments || {});
          break;
        case 'advancedConversationSearch':
          result = await this.advancedConversationSearch(request.params.arguments || {});
          break;
        case 'comprehensiveConversationSearch':
          result = await this.comprehensiveConversationSearch(request.params.arguments || {});
          break;
        case 'structuredConversationFilter':
          result = await this.structuredConversationFilter(request.params.arguments || {});
          break;
        case 'listUsers':
          result = await this.listUsers(request.params.arguments || {});
          break;
        case 'getCompanyReport':
          result = await this.getCompanyReport(request.params.arguments || {});
          break;
        case 'getUserReport':
          result = await this.getUserReport(request.params.arguments || {});
          break;
        case 'getProductivityReport':
          result = await this.getProductivityReport(request.params.arguments || {});
          break;
        case 'getAttachments':
          result = await this.getAttachments(request.params.arguments || {});
          break;
        case 'getAttachmentData':
          result = await this.getAttachmentData(request.params.arguments || {});
          break;
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }

      const duration = Date.now() - startTime;
      // Add to call history for future validation
      this.callHistory.push(request.params.name);
      
      // Enhance result with API constraint guidance
      const guidance = HelpScoutAPIConstraints.generateToolGuidance(
        request.params.name, 
        JSON.parse((result.content[0] as any).text), 
        validationContext
      );
      
      if (guidance.length > 0) {
        const originalContent = JSON.parse((result.content[0] as any).text);
        originalContent.apiGuidance = guidance;
        result.content[0] = {
          type: 'text',
          text: JSON.stringify(originalContent, null, 2)
        };
      }

      logger.info('Tool call completed', {
        requestId,
        toolName: request.params.name,
        duration,
        validationPassed: true,
        guidanceProvided: guidance.length > 0
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      return createMcpToolError(error, {
        toolName: request.params.name,
        requestId,
        duration,
      });
    }
  }

  private async searchInboxes(args: unknown): Promise<CallToolResult> {
    const input = SearchInboxesInputSchema.parse(args);
    const response = await helpScoutClient.get<PaginatedResponse<Inbox>>('/mailboxes', {
      page: 1,
      size: input.limit,
    });

    const inboxes = response._embedded?.mailboxes || [];
    const filteredInboxes = inboxes.filter(inbox => 
      inbox.name.toLowerCase().includes(input.query.toLowerCase())
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: filteredInboxes.map(inbox => ({
              id: inbox.id,
              name: inbox.name,
              email: inbox.email,
              createdAt: inbox.createdAt,
              updatedAt: inbox.updatedAt,
            })),
            query: input.query,
            totalFound: filteredInboxes.length,
            totalAvailable: inboxes.length,
            usage: filteredInboxes.length > 0 ? 
              'NEXT STEP: Use the "id" field from these results in your conversation search tools (comprehensiveConversationSearch or searchConversations)' : 
              'No inboxes matched your query. Try a different search term or use empty string "" to list all inboxes.',
            example: filteredInboxes.length > 0 ? 
              `comprehensiveConversationSearch({ searchTerms: ["your search"], inboxId: "${filteredInboxes[0].id}" })` : 
              null,
          }, null, 2),
        },
      ],
    };
  }

  private async searchConversations(args: unknown): Promise<CallToolResult> {
    const input = SearchConversationsInputSchema.parse(args);

    const baseParams: Record<string, unknown> = {
      page: 1,
      size: input.limit,
      sortField: input.sort,
      sortOrder: input.order,
    };

    // Add HelpScout query parameter for content/body search
    if (input.query) {
      baseParams.query = input.query;
    }

    // Apply inbox scoping: explicit inboxId > default > all inboxes
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;
    if (effectiveInboxId) {
      baseParams.mailbox = effectiveInboxId;
    }

    if (input.tag) baseParams.tag = input.tag;

    const queryWithDate = this.appendCreatedAtFilter(
      baseParams.query as string | undefined,
      input.createdAfter
    );
    if (queryWithDate) baseParams.query = queryWithDate;

    let conversations: Conversation[] = [];
    let searchedStatuses: string[];
    let pagination: unknown = null;

    if (input.status) {
      // Explicit status: single API call
      const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', {
        ...baseParams,
        status: input.status,
      });
      conversations = response._embedded?.conversations || [];
      searchedStatuses = [input.status];
      pagination = response.page;
    } else {
      // No status specified: search all statuses in parallel
      const statuses = ['active', 'pending', 'closed'] as const;
      searchedStatuses = [...statuses];

      const results = await Promise.allSettled(
        statuses.map(status =>
          helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', {
            ...baseParams,
            status,
          })
        )
      );

      // Merge and dedupe by conversation ID, handling partial failures
      // Track both returned conversations AND total available from API
      const seenIds = new Set<number>();
      const failedStatuses: Array<{ status: string; message: string; code: string }> = [];
      let totalAvailable = 0;
      const totalByStatus: Record<string, number> = {};

      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          const statusName = statuses[index];
          const statusTotal = result.value.page?.totalElements || 0;
          totalByStatus[statusName] = statusTotal;
          totalAvailable += statusTotal;

          const responseConversations = result.value._embedded?.conversations || [];
          for (const conv of responseConversations) {
            if (!seenIds.has(conv.id)) {
              seenIds.add(conv.id);
              conversations.push(conv);
            }
          }
        } else {
          const failedStatus = statuses[index];
          const reason = result.reason;
          const errorMessage = isApiError(reason)
            ? reason.message
            : (reason instanceof Error ? reason.message : String(reason));
          const errorCode = isApiError(reason) ? reason.code : 'UNKNOWN';

          // Non-API errors (TypeError, ReferenceError, etc.) should not be
          // silently swallowed - rethrow so programming bugs surface.
          if (!isApiError(reason)) {
            throw reason;
          }

          // Critical API errors should abort, not return partial results.
          // Note: currently blocked by validateStatus < 500 (NAS-465) which
          // prevents 4xx from reaching this path. Will activate once fixed.
          if (errorCode === 'UNAUTHORIZED' || errorCode === 'INVALID_INPUT') {
            throw reason;
          }

          failedStatuses.push({
            status: failedStatus,
            message: errorMessage,
            code: errorCode,
          });

          // Log as ERROR since this affects data completeness
          logger.error('Status search failed - partial results will be returned', {
            status: failedStatus,
            errorCode,
            message: errorMessage,
            note: 'This status will be excluded from results'
          });
        }
      }

      // Update searchedStatuses to reflect only successful searches
      if (failedStatuses.length > 0) {
        searchedStatuses = statuses.filter(s => !failedStatuses.some(f => f.status === s));
      }

      // Sort merged results by createdAt descending (most recent first)
      conversations.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      // Limit to requested size after merging
      const effectiveLimit = input.limit || 50;
      if (conversations.length > effectiveLimit) {
        conversations = conversations.slice(0, effectiveLimit);
      }

      // Pagination for merged results - show both returned count and real total
      pagination = {
        totalResults: conversations.length,
        totalAvailable: Object.keys(totalByStatus).length > 0 ? totalAvailable : undefined,
        totalByStatus: Object.keys(totalByStatus).length > 0 ? totalByStatus : undefined,
        errors: failedStatuses.length > 0 ? failedStatuses : undefined,
        note: failedStatuses.length > 0
          ? `[WARNING] ${failedStatuses.length} status(es) failed - results incomplete! Failed: ${failedStatuses.map(f => `${f.status} (${f.code})`).join(', ')}. Totals reflect successful statuses only.`
          : `Merged results from ${Object.keys(totalByStatus).length} statuses. Returned ${conversations.length} of ${totalAvailable} total conversations.`
      };
      logger.info('Multi-status search completed', {
        statusesSearched: searchedStatuses,
        failedStatuses: failedStatuses.length > 0 ? failedStatuses : undefined,
        totalResults: conversations.length,
        totalAvailable: failedStatuses.length > 0 ? 'partial failure' : totalAvailable
      });
    }

    // Apply client-side createdBefore filtering
    // NOTE: Help Scout API doesn't support createdBefore natively, so this filters after fetching
    // Pagination is rebuilt below to distinguish filtered count from API total
    let clientSideFiltered = false;
    const originalPagination = pagination;

    if (input.createdBefore) {
      const filterResult = this.applyCreatedBeforeFilter(conversations, input.createdBefore, 'searchConversations');
      conversations = filterResult.filtered;
      clientSideFiltered = filterResult.wasFiltered;

      if (clientSideFiltered) {
        // Rebuild pagination to show both filtered and pre-filter counts
        if (input.status) {
          // Single-status path: originalPagination is Help Scout's page object with totalElements
          pagination = this.buildFilteredPagination(
            conversations.length,
            originalPagination as { totalElements?: number } | undefined,
            true
          );
        } else {
          // Multi-status path: originalPagination has our custom merged structure
          const merged = originalPagination as {
            totalAvailable?: number;
            totalByStatus?: Record<string, number>;
            errors?: Array<{ status: string; message: string; code: string }>;
            note?: string;
          } | null;
          pagination = {
            totalResults: conversations.length,
            totalAvailable: merged?.totalAvailable,
            totalByStatus: merged?.totalByStatus,
            errors: merged?.errors,
            note: `Client-side createdBefore filter applied to merged results. totalResults shows filtered count (${conversations.length}), totalAvailable shows pre-filter total (${merged?.totalAvailable}). ${merged?.note || ''}`
          };
        }
      }
    }

    // Apply field selection if specified
    if (input.fields && input.fields.length > 0) {
      conversations = conversations.map(conv => {
        const filtered: Partial<Conversation> = {};
        input.fields!.forEach(field => {
          if (field in conv) {
            (filtered as any)[field] = (conv as any)[field];
          }
        });
        return filtered as Conversation;
      });
    }

    const results = {
      results: conversations,
      pagination,
      searchInfo: {
        query: input.query,
        statusesSearched: searchedStatuses,
        inboxScope: this.formatInboxScope(effectiveInboxId, input.inboxId),
        clientSideFiltering: clientSideFiltered ? 'createdBefore filter applied after API fetch - see pagination.totalResults for filtered count and pagination.totalAvailable for API total' : undefined,
        searchGuidance: conversations.length === 0 ? [
          'If no results found, try:',
          '1. Broaden search terms or extend time range',
          '2. Check if inbox ID is correct',
          '3. Try including spam status explicitly',
          !effectiveInboxId ? '4. Set HELPSCOUT_DEFAULT_INBOX_ID to scope searches to your primary inbox' : undefined
        ].filter(Boolean) : (!effectiveInboxId ? [
          'Note: Searching ALL inboxes. For better LLM context, set HELPSCOUT_DEFAULT_INBOX_ID environment variable.'
        ] : undefined),
      },
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }

  private async getConversationSummary(args: unknown): Promise<CallToolResult> {
    const input = GetConversationSummaryInputSchema.parse(args);
    
    // Get conversation details
    const conversation = await helpScoutClient.get<Conversation>(`/conversations/${input.conversationId}`);
    
    // Get threads to find first customer message and latest staff reply
    const threadsResponse = await helpScoutClient.get<PaginatedResponse<Thread>>(
      `/conversations/${input.conversationId}/threads`,
      { page: 1, size: 50 }
    );
    
    const threads = threadsResponse._embedded?.threads || [];
    const customerThreads = threads.filter(t => t.type === 'customer');
    const staffThreads = threads.filter(t => t.type === 'message' && t.createdBy);
    
    const firstCustomerMessage = customerThreads.sort((a, b) => 
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )[0];
    
    const latestStaffReply = staffThreads.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    // Helper to process body: redact PII, strip HTML, strip quoted/forwarded content
    const processBody = (body: string | undefined): string => {
      if (!config.security.allowPii) return '[Content hidden - set REDACT_MESSAGE_CONTENT=false to view]';
      if (!body) return '';
      if (config.formatting.stripHtml) {
        let text = stripHtml(body, config.formatting.maxBodyLength || undefined);
        text = stripQuotedContent(text);
        return text;
      }
      return body;
    };

    const summary = {
      conversation: {
        id: conversation.id,
        subject: conversation.subject,
        status: conversation.status,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        customer: conversation.customer,
        assignee: conversation.assignee,
        tags: conversation.tags,
      },
      firstCustomerMessage: firstCustomerMessage ? {
        id: firstCustomerMessage.id,
        body: processBody(firstCustomerMessage.body),
        createdAt: firstCustomerMessage.createdAt,
        customer: firstCustomerMessage.customer,
      } : null,
      latestStaffReply: latestStaffReply ? {
        id: latestStaffReply.id,
        body: processBody(latestStaffReply.body),
        createdAt: latestStaffReply.createdAt,
        createdBy: latestStaffReply.createdBy,
      } : null,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }

  private async getThreads(args: unknown): Promise<CallToolResult> {
    const input = GetThreadsInputSchema.parse(args);
    
    const response = await helpScoutClient.get<PaginatedResponse<Thread>>(
      `/conversations/${input.conversationId}/threads`,
      {
        page: 1,
        size: input.limit,
      }
    );

    const threads = response._embedded?.threads || [];
    
    // Redact PII if configured, then strip HTML + quoted content if configured
    // Strip _embedded (contains raw attachment objects — use getAttachments instead)
    const processedThreads = threads.map(thread => {
      const { _embedded, body: rawBody, ...rest } = thread as any;
      let body = config.security.allowPii ? rawBody : '[Content hidden - set REDACT_MESSAGE_CONTENT=false to view]';
      if (config.security.allowPii && config.formatting.stripHtml && body) {
        body = stripHtml(body, config.formatting.maxBodyLength || undefined);
        body = stripQuotedContent(body);
      }
      const attachmentCount = _embedded?.attachments?.length || 0;
      return { ...rest, body, attachmentCount };
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            conversationId: input.conversationId,
            threads: processedThreads,
            pagination: response.page,
            nextCursor: response._links?.next?.href,
          }, null, 2),
        },
      ],
    };
  }

  private async getServerTime(): Promise<CallToolResult> {
    const now = new Date();
    const serverTime: ServerTime = {
      isoTime: now.toISOString(),
      unixTime: Math.floor(now.getTime() / 1000),
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(serverTime, null, 2),
        },
      ],
    };
  }

  private async listAllInboxes(args: unknown): Promise<CallToolResult> {
    const input = args as { limit?: number };
    const limit = input.limit || 100;

    const response = await helpScoutClient.get<PaginatedResponse<Inbox>>('/mailboxes', {
      page: 1,
      size: limit,
    });

    const inboxes = response._embedded?.mailboxes || [];

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            inboxes: inboxes.map(inbox => ({
              id: inbox.id,
              name: inbox.name,
              email: inbox.email,
              createdAt: inbox.createdAt,
              updatedAt: inbox.updatedAt,
            })),
            totalInboxes: inboxes.length,
            usage: 'Use the "id" field from these results in your conversation searches',
            nextSteps: [
              'To search in a specific inbox, use the inbox ID with comprehensiveConversationSearch or searchConversations',
              'To search across all inboxes, omit the inboxId parameter',
            ],
          }, null, 2),
        },
      ],
    };
  }

  private async advancedConversationSearch(args: unknown): Promise<CallToolResult> {
    const input = AdvancedConversationSearchInputSchema.parse(args);

    // Build HelpScout query syntax
    const queryParts: string[] = [];

    // Content/body search (with injection protection)
    if (input.contentTerms && input.contentTerms.length > 0) {
      const bodyQueries = input.contentTerms.map(term => `body:"${this.escapeQueryTerm(term)}"`);
      queryParts.push(`(${bodyQueries.join(' OR ')})`);
    }

    // Subject search (with injection protection)
    if (input.subjectTerms && input.subjectTerms.length > 0) {
      const subjectQueries = input.subjectTerms.map(term => `subject:"${this.escapeQueryTerm(term)}"`);
      queryParts.push(`(${subjectQueries.join(' OR ')})`);
    }

    // Email searches (with injection protection)
    if (input.customerEmail) {
      queryParts.push(`email:"${this.escapeQueryTerm(input.customerEmail)}"`);
    }

    // Handle email domain search (with injection protection)
    if (input.emailDomain) {
      const domain = input.emailDomain.replace('@', ''); // Remove @ if present
      queryParts.push(`email:"${this.escapeQueryTerm(domain)}"`);
    }

    // Tag search (with injection protection)
    if (input.tags && input.tags.length > 0) {
      const tagQueries = input.tags.map(tag => `tag:"${this.escapeQueryTerm(tag)}"`);
      queryParts.push(`(${tagQueries.join(' OR ')})`);
    }

    // Build final query
    const queryString = queryParts.length > 0 ? queryParts.join(' AND ') : undefined;

    // Set up query parameters
    const queryParams: Record<string, unknown> = {
      page: 1,
      size: input.limit || 50,
      sortField: 'createdAt',
      sortOrder: 'desc',
    };

    if (queryString) {
      queryParams.query = queryString;
    }

    // Apply inbox scoping: explicit inboxId > default > all inboxes
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;
    if (effectiveInboxId) {
      queryParams.mailbox = effectiveInboxId;
    }

    // Default to all statuses for consistency with searchConversations (v1.6.0+)
    queryParams.status = input.status || 'all';

    const queryWithDate = this.appendCreatedAtFilter(
      queryParams.query as string | undefined,
      input.createdAfter
    );
    if (queryWithDate) queryParams.query = queryWithDate;

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);

    let conversations = response._embedded?.conversations || [];

    let clientSideFiltered = false;
    const originalCount = conversations.length;
    if (input.createdBefore) {
      const result = this.applyCreatedBeforeFilter(conversations, input.createdBefore, 'advancedConversationSearch');
      conversations = result.filtered;
      clientSideFiltered = result.wasFiltered;
    }

    const paginationInfo = this.buildFilteredPagination(conversations.length, response.page, clientSideFiltered);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: conversations,
            searchQuery: queryString,
            inboxScope: this.formatInboxScope(effectiveInboxId, input.inboxId),
            searchCriteria: {
              contentTerms: input.contentTerms,
              subjectTerms: input.subjectTerms,
              customerEmail: input.customerEmail,
              emailDomain: input.emailDomain,
              tags: input.tags,
            },
            pagination: paginationInfo,
            nextCursor: response._links?.next?.href,
            clientSideFiltering: clientSideFiltered ? `createdBefore filter removed ${originalCount - conversations.length} of ${originalCount} results` : undefined,
            note: !effectiveInboxId ? 'Searching ALL inboxes. Set HELPSCOUT_DEFAULT_INBOX_ID for better LLM context.' : undefined,
          }, null, 2),
        },
      ],
    };
  }

  /**
   * Performs comprehensive conversation search across multiple statuses
   * @param args - Search parameters including search terms, statuses, and timeframe
   * @returns Promise<CallToolResult> with search results organized by status
   * @example
   * comprehensiveConversationSearch({
   *   searchTerms: ["urgent", "billing"],
   *   timeframeDays: 30,
   *   inboxId: "123456"
   * })
   */
  private async comprehensiveConversationSearch(args: unknown): Promise<CallToolResult> {
    const input = MultiStatusConversationSearchInputSchema.parse(args);
    
    const searchContext = this.buildComprehensiveSearchContext(input);
    const searchResults = await this.executeMultiStatusSearch(searchContext);
    const summary = this.formatComprehensiveSearchResults(searchResults, searchContext);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }

  /**
   * Build search context from input parameters
   */
  private buildComprehensiveSearchContext(input: z.infer<typeof MultiStatusConversationSearchInputSchema>) {
    const createdAfter = input.createdAfter || this.calculateTimeRange(input.timeframeDays);
    const searchQuery = this.buildSearchQuery(input.searchTerms, input.searchIn);
    // Apply inbox scoping: explicit inboxId > default > all inboxes
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;

    return {
      input,
      createdAfter,
      searchQuery,
      effectiveInboxId,
    };
  }

  /**
   * Calculate time range for search
   * Note: Help Scout API requires ISO 8601 format WITHOUT milliseconds
   */
  private calculateTimeRange(timeframeDays: number): string {
    const timeRange = new Date();
    timeRange.setDate(timeRange.getDate() - timeframeDays);
    // Strip milliseconds - Help Scout rejects dates with .xxx format
    return timeRange.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /**
   * Build Help Scout search query from terms and search locations (with injection protection)
   */
  private buildSearchQuery(terms: string[], searchIn: string[]): string {
    const queries: string[] = [];

    for (const term of terms) {
      const termQueries: string[] = [];
      const escapedTerm = this.escapeQueryTerm(term);

      if (searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.BODY) || searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.BOTH)) {
        termQueries.push(`body:"${escapedTerm}"`);
      }

      if (searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.SUBJECT) || searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.BOTH)) {
        termQueries.push(`subject:"${escapedTerm}"`);
      }

      if (termQueries.length > 0) {
        queries.push(`(${termQueries.join(' OR ')})`);
      }
    }

    return queries.join(' OR ');
  }

  /**
   * Execute search across multiple statuses with error handling
   */
  private async executeMultiStatusSearch(context: {
    input: z.infer<typeof MultiStatusConversationSearchInputSchema>;
    createdAfter: string;
    searchQuery: string;
    effectiveInboxId?: string;
  }) {
    const { input, createdAfter, searchQuery, effectiveInboxId } = context;
    const allResults: Array<{
      status: string;
      totalCount: number;
      totalCountBeforeFilter?: number;
      conversations: Conversation[];
      searchQuery: string;
      filteredByCreatedBefore?: boolean;
    }> = [];

    for (const status of input.statuses) {
      try {
        const result = await this.searchSingleStatus({
          status,
          searchQuery,
          createdAfter,
          limitPerStatus: input.limitPerStatus,
          inboxId: effectiveInboxId,
          createdBefore: input.createdBefore,
        });
        allResults.push(result);
      } catch (error) {
        // Use type guard instead of unsafe cast
        if (!isApiError(error)) {
          // Non-API errors (TypeError, network failures) should not be silently swallowed
          logger.error('Unexpected non-API error in multi-status search', {
            status,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        // Critical API errors should fail the entire operation.
        // Note: currently blocked by validateStatus < 500 (NAS-465) which
        // treats 4xx as successful responses in axios, so they never reach
        // this catch block. Will activate once validateStatus is fixed.
        if (error.code === 'UNAUTHORIZED' || error.code === 'INVALID_INPUT') {
          logger.error('Critical API error in multi-status search - aborting', {
            status,
            errorCode: error.code,
            message: error.message
          });
          throw error;
        }

        // Non-critical API errors: log and include in response
        logger.error('Status search failed - partial results will be returned', {
          status,
          errorCode: error.code,
          message: error.message,
          note: 'This status will be excluded from results'
        });

        allResults.push({
          status,
          totalCount: 0,
          conversations: [],
          searchQuery,
        });
      }
    }

    return allResults;
  }

  /**
   * Apply client-side createdBefore filter (Help Scout API does not support this natively).
   * Returns filtered conversations and metadata about what was removed.
   */
  private applyCreatedBeforeFilter(
    conversations: Conversation[],
    createdBefore: string,
    context: string
  ): { filtered: Conversation[]; wasFiltered: boolean; removedCount: number } {
    const beforeDate = new Date(createdBefore);
    if (isNaN(beforeDate.getTime())) {
      throw new Error(`Invalid createdBefore date format: ${createdBefore}. Expected ISO 8601 format (e.g., 2023-01-15T00:00:00Z)`);
    }

    const originalCount = conversations.length;
    const filtered = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
    const removedCount = originalCount - filtered.length;

    if (removedCount > 0) {
      logger.warn(`Client-side createdBefore filter applied - ${context}`, {
        originalCount,
        filteredCount: filtered.length,
        removedCount,
        note: 'Help Scout API does not support createdBefore parameter natively'
      });
    }

    return { filtered, wasFiltered: removedCount > 0, removedCount };
  }

  /**
   * Build inbox scope description string for response metadata.
   */
  private formatInboxScope(effectiveInboxId: string | undefined, explicitInboxId: string | undefined): string {
    if (!effectiveInboxId) return 'ALL inboxes';
    return explicitInboxId ? `Specific inbox: ${effectiveInboxId}` : `Default inbox: ${effectiveInboxId}`;
  }

  /**
   * Build pagination info that distinguishes filtered count from API total.
   * Used when createdBefore client-side filtering modifies a single API response.
   */
  private buildFilteredPagination(
    filteredCount: number,
    apiPage: { totalElements?: number } | undefined,
    wasFiltered: boolean
  ): unknown {
    if (!wasFiltered) return apiPage;
    return {
      totalResults: filteredCount,
      totalAvailable: apiPage?.totalElements,
      note: `Results filtered client-side by createdBefore. totalResults shows filtered count (${filteredCount}), totalAvailable shows pre-filter API total (${apiPage?.totalElements}).`
    };
  }

  /**
   * Search conversations for a single status
   */
  private async searchSingleStatus(params: {
    status: string;
    searchQuery: string;
    createdAfter: string;
    limitPerStatus: number;
    inboxId?: string;
    createdBefore?: string;
  }) {
    const queryWithDate = this.appendCreatedAtFilter(
      params.searchQuery,
      params.createdAfter
    );

    const queryParams: Record<string, unknown> = {
      page: 1,
      size: params.limitPerStatus,
      sortField: TOOL_CONSTANTS.DEFAULT_SORT_FIELD,
      sortOrder: TOOL_CONSTANTS.DEFAULT_SORT_ORDER,
      query: queryWithDate || params.searchQuery,
      status: params.status,
    };

    if (params.inboxId) {
      queryParams.mailbox = params.inboxId;
    }

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);
    let conversations = response._embedded?.conversations || [];
    const apiTotalElements = response.page?.totalElements || conversations.length;

    let filteredByDate = false;
    if (params.createdBefore) {
      const result = this.applyCreatedBeforeFilter(conversations, params.createdBefore, `searchSingleStatus(${params.status})`);
      conversations = result.filtered;
      filteredByDate = result.wasFiltered;
    }

    return {
      status: params.status,
      totalCount: filteredByDate ? conversations.length : apiTotalElements,
      totalCountBeforeFilter: filteredByDate ? apiTotalElements : undefined,
      conversations,
      searchQuery: params.searchQuery,
      filteredByCreatedBefore: filteredByDate,
    };
  }

  /**
   * Format comprehensive search results into summary response
   */
  private formatComprehensiveSearchResults(
    allResults: Array<{
      status: string;
      totalCount: number;
      totalCountBeforeFilter?: number;
      conversations: Conversation[];
      searchQuery: string;
      filteredByCreatedBefore?: boolean;
    }>,
    context: {
      input: z.infer<typeof MultiStatusConversationSearchInputSchema>;
      createdAfter: string;
      searchQuery: string;
      effectiveInboxId?: string;
    }
  ) {
    const { input, createdAfter, searchQuery, effectiveInboxId } = context;
    const totalConversations = allResults.reduce((sum, result) => sum + result.conversations.length, 0);
    const totalAvailable = allResults.reduce((sum, result) => sum + result.totalCount, 0);
    const hasClientSideFiltering = allResults.some(r => r.filteredByCreatedBefore);
    const totalBeforeFilter = hasClientSideFiltering
      ? allResults.reduce((sum, result) => sum + (result.totalCountBeforeFilter || result.totalCount), 0)
      : undefined;

    return {
      searchTerms: input.searchTerms,
      searchQuery,
      searchIn: input.searchIn,
      inboxScope: this.formatInboxScope(effectiveInboxId, input.inboxId),
      timeframe: {
        createdAfter,
        createdBefore: input.createdBefore,
        days: input.timeframeDays,
      },
      totalConversationsFound: totalConversations,
      totalAvailableAcrossStatuses: totalAvailable,
      totalBeforeClientSideFiltering: totalBeforeFilter,
      clientSideFilteringApplied: hasClientSideFiltering ?
        `createdBefore filter applied - totalConversationsFound (${totalConversations}) reflects filtered results, totalBeforeClientSideFiltering (${totalBeforeFilter}) shows pre-filter API totals` : undefined,
      resultsByStatus: allResults,
      searchTips: totalConversations === 0 ? [
        'Try broader search terms or increase the timeframe',
        'Check if the inbox ID is correct',
        'Consider searching without status restrictions first',
        'Verify that conversations exist for the specified criteria',
        !effectiveInboxId ? 'Set HELPSCOUT_DEFAULT_INBOX_ID to scope searches to your primary inbox' : undefined
      ].filter(Boolean) : (!effectiveInboxId ? [
        'Note: Searching ALL inboxes. For better LLM context, set HELPSCOUT_DEFAULT_INBOX_ID environment variable.'
      ] : undefined),
    };
  }

  private async structuredConversationFilter(args: unknown): Promise<CallToolResult> {
    const input = StructuredConversationFilterInputSchema.parse(args);

    const queryParams: Record<string, unknown> = {
      page: 1,
      size: input.limit,
      sortField: input.sortBy,
      sortOrder: input.sortOrder,
    };

    // Apply unique structural filters
    if (input.assignedTo !== undefined) queryParams.assigned_to = input.assignedTo;
    if (input.folderId !== undefined) queryParams.folder = input.folderId;
    if (input.conversationNumber !== undefined) queryParams.number = input.conversationNumber;

    // Apply customerIds via query syntax if provided
    if (input.customerIds && input.customerIds.length > 0) {
      queryParams.query = `(${input.customerIds.map(id => `customerIds:${id}`).join(' OR ')})`;
    }

    // Apply combination filters
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;
    if (effectiveInboxId) queryParams.mailbox = effectiveInboxId;
    // Send status=all explicitly (Help Scout defaults to active-only when omitted)
    queryParams.status = input.status || 'all';
    if (input.tag) queryParams.tag = input.tag;
    if (input.modifiedSince) queryParams.modifiedSince = input.modifiedSince;

    const queryWithDate = this.appendCreatedAtFilter(
      queryParams.query as string | undefined,
      input.createdAfter
    );
    if (queryWithDate) queryParams.query = queryWithDate;

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);
    let conversations = response._embedded?.conversations || [];

    let clientSideFiltered = false;
    const originalCount = conversations.length;
    if (input.createdBefore) {
      const result = this.applyCreatedBeforeFilter(conversations, input.createdBefore, 'structuredConversationFilter');
      conversations = result.filtered;
      clientSideFiltered = result.wasFiltered;
    }

    const paginationInfo = this.buildFilteredPagination(conversations.length, response.page, clientSideFiltered);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: conversations,
          filterApplied: {
            filterType: 'structural',
            assignedTo: input.assignedTo,
            folderId: input.folderId,
            customerIds: input.customerIds,
            conversationNumber: input.conversationNumber,
            uniqueSorting: ['waitingSince', 'customerName', 'customerEmail'].includes(input.sortBy) ? input.sortBy : undefined,
          },
          inboxScope: this.formatInboxScope(effectiveInboxId, input.inboxId),
          pagination: paginationInfo,
          nextCursor: response._links?.next?.href,
          clientSideFiltering: clientSideFiltered ? `createdBefore filter removed ${originalCount - conversations.length} of ${originalCount} results` : undefined,
          note: 'Structural filtering applied. For content-based search or rep activity, use comprehensiveConversationSearch.',
        }, null, 2),
      }],
    };
  }

  // ───────────────────────────────────────────────────────────────
  // Reports & Users tools
  // ───────────────────────────────────────────────────────────────

  /**
   * Build query params shared by all report endpoints.
   */
  private buildReportParams(input: Record<string, unknown>): Record<string, unknown> {
    const params: Record<string, unknown> = {
      start: input.start,
      end: input.end,
    };
    if (input.previousStart) params.previousStart = input.previousStart;
    if (input.previousEnd) params.previousEnd = input.previousEnd;
    if (input.mailboxes) params.mailboxes = input.mailboxes;
    if (input.tags) params.tags = input.tags;
    if (input.types) params.types = input.types;
    if (input.folders) params.folders = input.folders;
    return params;
  }

  private async listUsers(args: unknown): Promise<CallToolResult> {
    const input = ListUsersInputSchema.parse(args);
    const params: Record<string, unknown> = {
      page: input.page,
    };
    if (input.email) params.email = input.email;
    if (input.mailbox) params.mailbox = input.mailbox;

    interface UserResponse {
      id: number;
      firstName: string;
      lastName: string;
      email: string;
      role: string;
      type: string;
    }

    const response = await helpScoutClient.get<PaginatedResponse<UserResponse>>('/users', params);
    const users = response._embedded?.users || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          users: users.map(u => ({
            id: u.id,
            name: `${u.firstName} ${u.lastName}`,
            email: u.email,
            role: u.role,
            type: u.type,
          })),
          totalUsers: response.page?.totalElements || users.length,
          page: response.page?.number || 1,
          totalPages: response.page?.totalPages || 1,
          nextSteps: [
            'Use user IDs with getUserReport for per-agent stats',
            'Use getCompanyReport to compare all agents at once',
          ],
        }, null, 2),
      }],
    };
  }

  private async getCompanyReport(args: unknown): Promise<CallToolResult> {
    const input = GetCompanyReportInputSchema.parse(args);
    const params = this.buildReportParams(input as unknown as Record<string, unknown>);

    const response = await helpScoutClient.get<Record<string, unknown>>('/reports/company', params);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...response,
          nextSteps: [
            'Use getUserReport with a specific user ID for deeper per-agent stats',
            'Use getProductivityReport for team-wide response/resolution time distributions',
          ],
        }, null, 2),
      }],
    };
  }

  private async getUserReport(args: unknown): Promise<CallToolResult> {
    const input = GetUserReportInputSchema.parse(args);
    const params = this.buildReportParams(input as unknown as Record<string, unknown>);
    params.user = input.user;

    const response = await helpScoutClient.get<Record<string, unknown>>('/reports/user', params);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response, null, 2),
      }],
    };
  }

  private async getProductivityReport(args: unknown): Promise<CallToolResult> {
    const input = GetProductivityReportInputSchema.parse(args);
    const params = this.buildReportParams(input as unknown as Record<string, unknown>);

    const response = await helpScoutClient.get<Record<string, unknown>>('/reports/productivity', params);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response, null, 2),
      }],
    };
  }

  private async getAttachments(args: unknown): Promise<CallToolResult> {
    const input = GetAttachmentsInputSchema.parse(args);

    const response = await helpScoutClient.get<PaginatedResponse<any>>(
      `/conversations/${input.conversationId}/threads`,
      { page: 1, size: TOOL_CONSTANTS.MAX_THREAD_SIZE }
    );

    const threads = response._embedded?.threads || [];
    const attachments: any[] = [];

    for (const thread of threads) {
      const threadAttachments = (thread as any)._embedded?.attachments || [];
      for (const att of threadAttachments) {
        attachments.push({
          attachmentId: att.id,
          threadId: thread.id,
          filename: att.filename || att.fileName,
          mimeType: att.mimeType,
          size: att.size,
          width: att.width || null,
          height: att.height || null,
          state: att.state || 'unknown',
          threadCreatedAt: thread.createdAt,
        });
      }
    }

    // Warn about virus-flagged attachments
    const virusWarnings = attachments
      .filter(a => a.state === 'virus')
      .map(a => `WARNING: ${a.filename} (ID ${a.attachmentId}) flagged as virus`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          conversationId: input.conversationId,
          attachments,
          totalCount: attachments.length,
          ...(virusWarnings.length > 0 ? { virusWarnings } : {}),
        }, null, 2),
      }],
    };
  }

  private async getAttachmentData(args: unknown): Promise<CallToolResult> {
    const input = GetAttachmentDataInputSchema.parse(args);

    // First get attachment metadata to know mimeType
    const threadsResponse = await helpScoutClient.get<PaginatedResponse<any>>(
      `/conversations/${input.conversationId}/threads`,
      { page: 1, size: TOOL_CONSTANTS.MAX_THREAD_SIZE }
    );

    const threads = threadsResponse._embedded?.threads || [];
    let attachmentMeta: any = null;

    for (const thread of threads) {
      const threadAttachments = (thread as any)._embedded?.attachments || [];
      const found = threadAttachments.find((a: any) => String(a.id) === String(input.attachmentId));
      if (found) {
        attachmentMeta = found;
        break;
      }
    }

    if (!attachmentMeta) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: { code: 'NOT_FOUND', message: `Attachment ${input.attachmentId} not found in conversation ${input.conversationId}` } }, null, 2) }],
        isError: true,
      };
    }

    if (attachmentMeta.state === 'virus') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: { code: 'BLOCKED', message: `Attachment ${input.attachmentId} (${attachmentMeta.filename}) is flagged as a virus. Download blocked.` } }, null, 2) }],
        isError: true,
      };
    }

    // Download attachment data
    const dataResponse = await helpScoutClient.get<{ data: string }>(
      `/conversations/${input.conversationId}/attachments/${input.attachmentId}/data`
    );

    const base64Data = dataResponse.data;
    const mimeType = attachmentMeta.mimeType || 'application/octet-stream';
    const isImage = mimeType.startsWith('image/');
    const base64SizeBytes = base64Data.length;
    const ONE_MB = 1_000_000;

    // Small images: return inline for Claude to see
    if (isImage && base64SizeBytes < ONE_MB) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              filename: attachmentMeta.filename,
              mimeType,
              size: attachmentMeta.size,
              width: attachmentMeta.width || null,
              height: attachmentMeta.height || null,
            }, null, 2),
          },
          {
            type: 'image',
            data: base64Data,
            mimeType,
          } as any,
        ],
      };
    }

    // Large images or non-images: save to temp file
    const ext = path.extname(attachmentMeta.filename || '') || (isImage ? '.png' : '.bin');
    const tempFilePath = path.join(os.tmpdir(), `helpscout_att_${input.attachmentId}${ext}`);
    fs.writeFileSync(tempFilePath, Buffer.from(base64Data, 'base64'));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          filename: attachmentMeta.filename,
          mimeType,
          size: attachmentMeta.size,
          savedTo: tempFilePath,
          note: isImage
            ? 'Image too large for inline display. Use the Read tool to view this file.'
            : 'Non-image file saved to disk. Use the Read tool to view this file.',
        }, null, 2),
      }],
    };
  }
}

export const toolHandler = new ToolHandler();