import { eq, sql } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'
import { createLogger } from '@/lib/logs/console-logger'
import { persistExecutionError, persistExecutionLogs } from '@/lib/logs/execution-logger'
import { buildTraceSpans } from '@/lib/logs/trace-spans'
import { checkServerSideUsageLimits } from '@/lib/usage-monitor'
import { decryptSecret } from '@/lib/utils'
import { loadWorkflowFromNormalizedTables } from '@/lib/workflows/db-helpers'
import {
  createHttpResponseFromBlock,
  updateWorkflowRunCounts,
  workflowHasResponseBlock,
} from '@/lib/workflows/utils'
import { db } from '@/db'
import { environment, userStats } from '@/db/schema'
import { Executor } from '@/executor'
import { Serializer } from '@/serializer'
import { mergeSubblockState } from '@/stores/workflows/server-utils'
import type { WorkflowState } from '@/stores/workflows/workflow/types'
import { validateWorkflowAccess } from '../../middleware'
import { createErrorResponse, createSuccessResponse } from '../../utils'

const logger = createLogger('WorkflowExecuteAPI')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Define the schema for environment variables
const EnvVarsSchema = z.record(z.string())

// Keep track of running executions to prevent duplicate requests
// Use a combination of workflow ID and request ID to allow concurrent executions with different inputs
const runningExecutions = new Set<string>()

// Custom error class for usage limit exceeded
class UsageLimitError extends Error {
  statusCode: number

  constructor(message: string) {
    super(message)
    this.name = 'UsageLimitError'
    this.statusCode = 402 // Payment Required status code
  }
}

async function executeWorkflow(workflow: any, requestId: string, input?: any) {
  const workflowId = workflow.id
  const executionId = uuidv4()

  // Create a unique execution key combining workflow ID and request ID
  // This allows concurrent executions of the same workflow with different inputs
  const executionKey = `${workflowId}:${requestId}`

  // Skip if this exact execution is already running (prevents duplicate requests)
  if (runningExecutions.has(executionKey)) {
    logger.warn(`[${requestId}] Execution is already running: ${executionKey}`)
    throw new Error('Execution is already running')
  }

  // Check if the user has exceeded their usage limits
  const usageCheck = await checkServerSideUsageLimits(workflow.userId)
  if (usageCheck.isExceeded) {
    logger.warn(`[${requestId}] User ${workflow.userId} has exceeded usage limits`, {
      currentUsage: usageCheck.currentUsage,
      limit: usageCheck.limit,
    })
    throw new UsageLimitError(
      usageCheck.message || 'Usage limit exceeded. Please upgrade your plan to continue.'
    )
  }

  // Log input to help debug
  logger.info(
    `[${requestId}] Executing workflow with input:`,
    input ? JSON.stringify(input, null, 2) : 'No input provided'
  )

  // Use input directly for API workflows
  const processedInput = input
  logger.info(
    `[${requestId}] Using input directly for workflow:`,
    JSON.stringify(processedInput, null, 2)
  )

  try {
    runningExecutions.add(executionKey)
    logger.info(`[${requestId}] Starting workflow execution: ${workflowId}`)

    // Load workflow data from normalized tables
    logger.debug(`[${requestId}] Loading workflow ${workflowId} from normalized tables`)
    const normalizedData = await loadWorkflowFromNormalizedTables(workflowId)

    let blocks: Record<string, any>
    let edges: any[]
    let loops: Record<string, any>
    let parallels: Record<string, any>

    if (normalizedData) {
      // Use normalized data as primary source
      ;({ blocks, edges, loops, parallels } = normalizedData)
      logger.info(`[${requestId}] Using normalized tables for workflow execution: ${workflowId}`)
    } else {
      // Fallback to deployed state if available (for legacy workflows)
      logger.warn(
        `[${requestId}] No normalized data found, falling back to deployed state for workflow: ${workflowId}`
      )

      if (!workflow.deployedState) {
        throw new Error(
          `Workflow ${workflowId} has no deployed state and no normalized data available`
        )
      }

      const deployedState = workflow.deployedState as WorkflowState
      ;({ blocks, edges, loops, parallels } = deployedState)
    }

    // Use the same execution flow as in scheduled executions
    const mergedStates = mergeSubblockState(blocks)

    // Fetch the user's environment variables (if any)
    const [userEnv] = await db
      .select()
      .from(environment)
      .where(eq(environment.userId, workflow.userId))
      .limit(1)

    if (!userEnv) {
      logger.debug(
        `[${requestId}] No environment record found for user ${workflow.userId}. Proceeding with empty variables.`
      )
    }

    // Parse and validate environment variables.
    const variables = EnvVarsSchema.parse(userEnv?.variables ?? {})

    // Replace environment variables in the block states
    const currentBlockStates = await Object.entries(mergedStates).reduce(
      async (accPromise, [id, block]) => {
        const acc = await accPromise
        acc[id] = await Object.entries(block.subBlocks).reduce(
          async (subAccPromise, [key, subBlock]) => {
            const subAcc = await subAccPromise
            let value = subBlock.value

            // If the value is a string and contains environment variable syntax
            if (typeof value === 'string' && value.includes('{{') && value.includes('}}')) {
              const matches = value.match(/{{([^}]+)}}/g)
              if (matches) {
                // Process all matches sequentially
                for (const match of matches) {
                  const varName = match.slice(2, -2) // Remove {{ and }}
                  const encryptedValue = variables[varName]
                  if (!encryptedValue) {
                    throw new Error(`Environment variable "${varName}" was not found`)
                  }

                  try {
                    const { decrypted } = await decryptSecret(encryptedValue)
                    value = (value as string).replace(match, decrypted)
                  } catch (error: any) {
                    logger.error(
                      `[${requestId}] Error decrypting environment variable "${varName}"`,
                      error
                    )
                    throw new Error(
                      `Failed to decrypt environment variable "${varName}": ${error.message}`
                    )
                  }
                }
              }
            }

            subAcc[key] = value
            return subAcc
          },
          Promise.resolve({} as Record<string, any>)
        )
        return acc
      },
      Promise.resolve({} as Record<string, Record<string, any>>)
    )

    // Create a map of decrypted environment variables
    const decryptedEnvVars: Record<string, string> = {}
    for (const [key, encryptedValue] of Object.entries(variables)) {
      try {
        const { decrypted } = await decryptSecret(encryptedValue)
        decryptedEnvVars[key] = decrypted
      } catch (error: any) {
        logger.error(`[${requestId}] Failed to decrypt environment variable "${key}"`, error)
        throw new Error(`Failed to decrypt environment variable "${key}": ${error.message}`)
      }
    }

    // Process the block states to ensure response formats are properly parsed
    const processedBlockStates = Object.entries(currentBlockStates).reduce(
      (acc, [blockId, blockState]) => {
        // Check if this block has a responseFormat that needs to be parsed
        if (blockState.responseFormat && typeof blockState.responseFormat === 'string') {
          try {
            logger.debug(`[${requestId}] Parsing responseFormat for block ${blockId}`)
            // Attempt to parse the responseFormat if it's a string
            const parsedResponseFormat = JSON.parse(blockState.responseFormat)

            acc[blockId] = {
              ...blockState,
              responseFormat: parsedResponseFormat,
            }
          } catch (error) {
            logger.warn(`[${requestId}] Failed to parse responseFormat for block ${blockId}`, error)
            acc[blockId] = blockState
          }
        } else {
          acc[blockId] = blockState
        }
        return acc
      },
      {} as Record<string, Record<string, any>>
    )

    // Get workflow variables
    let workflowVariables = {}
    if (workflow.variables) {
      try {
        // Parse workflow variables if they're stored as a string
        if (typeof workflow.variables === 'string') {
          workflowVariables = JSON.parse(workflow.variables)
        } else {
          // Otherwise use as is (already parsed JSON)
          workflowVariables = workflow.variables
        }
        logger.debug(
          `[${requestId}] Loaded ${Object.keys(workflowVariables).length} workflow variables for: ${workflowId}`
        )
      } catch (error) {
        logger.error(`[${requestId}] Failed to parse workflow variables: ${workflowId}`, error)
        // Continue execution even if variables can't be parsed
      }
    } else {
      logger.debug(`[${requestId}] No workflow variables found for: ${workflowId}`)
    }

    // Serialize and execute the workflow
    logger.debug(`[${requestId}] Serializing workflow: ${workflowId}`)
    const serializedWorkflow = new Serializer().serializeWorkflow(
      mergedStates,
      edges,
      loops,
      parallels
    )

    const executor = new Executor(
      serializedWorkflow,
      processedBlockStates,
      decryptedEnvVars,
      processedInput,
      workflowVariables
    )

    const result = await executor.execute(workflowId)

    // Check if we got a StreamingExecution result (with stream + execution properties)
    // For API routes, we only care about the ExecutionResult part, not the stream
    const executionResult = 'stream' in result && 'execution' in result ? result.execution : result

    logger.info(`[${requestId}] Workflow execution completed: ${workflowId}`, {
      success: executionResult.success,
      executionTime: executionResult.metadata?.duration,
    })

    // Update workflow run counts if execution was successful
    if (executionResult.success) {
      await updateWorkflowRunCounts(workflowId)

      // Track API call in user stats
      await db
        .update(userStats)
        .set({
          totalApiCalls: sql`total_api_calls + 1`,
          lastActive: new Date(),
        })
        .where(eq(userStats.userId, workflow.userId))
    }

    // Build trace spans from execution logs
    const { traceSpans, totalDuration } = buildTraceSpans(executionResult)

    // Add trace spans to the execution result
    const enrichedResult = {
      ...executionResult,
      traceSpans,
      totalDuration,
    }

    // Log each execution step and the final result
    await persistExecutionLogs(workflowId, executionId, enrichedResult, 'api')

    return executionResult
  } catch (error: any) {
    logger.error(`[${requestId}] Workflow execution failed: ${workflowId}`, error)
    // Log the error
    await persistExecutionError(workflowId, executionId, error, 'api')
    throw error
  } finally {
    runningExecutions.delete(executionKey)
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = crypto.randomUUID().slice(0, 8)
  const { id } = await params

  try {
    logger.debug(`[${requestId}] GET execution request for workflow: ${id}`)
    const validation = await validateWorkflowAccess(request, id)
    if (validation.error) {
      logger.warn(`[${requestId}] Workflow access validation failed: ${validation.error.message}`)
      return createErrorResponse(validation.error.message, validation.error.status)
    }

    const result = await executeWorkflow(validation.workflow, requestId)

    // Check if the workflow execution contains a response block output
    const hasResponseBlock = workflowHasResponseBlock(result)
    if (hasResponseBlock) {
      return createHttpResponseFromBlock(result)
    }

    return createSuccessResponse(result)
  } catch (error: any) {
    logger.error(`[${requestId}] Error executing workflow: ${id}`, error)

    // Check if this is a usage limit error
    if (error instanceof UsageLimitError) {
      return createErrorResponse(error.message, error.statusCode, 'USAGE_LIMIT_EXCEEDED')
    }

    return createErrorResponse(
      error.message || 'Failed to execute workflow',
      500,
      'EXECUTION_ERROR'
    )
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = crypto.randomUUID().slice(0, 8)
  const { id } = await params

  try {
    logger.debug(`[${requestId}] POST execution request for workflow: ${id}`)
    const validation = await validateWorkflowAccess(request, id)
    if (validation.error) {
      logger.warn(`[${requestId}] Workflow access validation failed: ${validation.error.message}`)
      return createErrorResponse(validation.error.message, validation.error.status)
    }

    const bodyText = await request.text()
    logger.info(`[${requestId}] Raw request body:`, bodyText)

    let body = {}
    if (bodyText?.trim()) {
      try {
        body = JSON.parse(bodyText)
        logger.info(`[${requestId}] Parsed request body:`, JSON.stringify(body, null, 2))
      } catch (error) {
        logger.error(`[${requestId}] Failed to parse request body:`, error)
        return createErrorResponse('Invalid JSON in request body', 400, 'INVALID_JSON')
      }
    } else {
      logger.info(`[${requestId}] No request body provided`)
    }

    // Pass the raw body directly as input for API workflows
    const hasContent = Object.keys(body).length > 0
    const input = hasContent ? body : {}

    logger.info(`[${requestId}] Input passed to workflow:`, JSON.stringify(input, null, 2))

    // Execute workflow with the raw input
    const result = await executeWorkflow(validation.workflow, requestId, input)

    // Check if the workflow execution contains a response block output
    const hasResponseBlock = workflowHasResponseBlock(result)
    if (hasResponseBlock) {
      return createHttpResponseFromBlock(result)
    }

    return createSuccessResponse(result)
  } catch (error: any) {
    logger.error(`[${requestId}] Error executing workflow: ${id}`, error)

    // Check if this is a usage limit error
    if (error instanceof UsageLimitError) {
      return createErrorResponse(error.message, error.statusCode, 'USAGE_LIMIT_EXCEEDED')
    }

    return createErrorResponse(
      error.message || 'Failed to execute workflow',
      500,
      'EXECUTION_ERROR'
    )
  }
}

export async function OPTIONS(_request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, X-API-Key, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version',
      'Access-Control-Max-Age': '86400',
    },
  })
}
