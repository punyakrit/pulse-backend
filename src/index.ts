import express from 'express';
import { checkWebsite, findAllWebsites, updateProject, createPerformanceMetric, createUptimeLog, alertWebsite } from './lib/query.js';
import cron from 'cron';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const app = express();
const prisma = new PrismaClient();

let websites: any[] = []
let activeJobs: Map<string, cron.CronJob> = new Map()

async function main() {
  const response = await findAllWebsites()
  websites = response
  checkWebsites()
}


function startCron() {
  const job = new cron.CronJob('*/30 * * * * *', async () => {
    const response = await findAllWebsites()
    if (JSON.stringify(response) === JSON.stringify(websites)) {
      console.log('No changes')
    } else {
      websites = response
      console.log('Updated websites:', websites.length, 'projects')
      checkWebsites()
    }
  })
  job.start()

  const dailyUptimeJob = new cron.CronJob('0 0 * * *', async () => {
    console.log('Calculating daily uptime statistics...')
    await calculateDailyUptime()
  })
  dailyUptimeJob.start()
}



async function checkWebsites() {
  const isActive = websites.filter((website) => website.status === 'online')

  const websiteExists = isActive.filter((website) => website.Website.length > 0)

  const websitesToMonitor = websiteExists.map((project) => ({
    projectId: project.id,
    projectName: project.name,
    interval: project.Setting?.interval,
    notifyType: project.Setting?.notifyType,
    websites: project.Website.map((website: any) => ({
      id: website.id,
      url: website.url
    }))
  }))


  setupMonitoringJobs(websitesToMonitor)
}

function setupMonitoringJobs(websitesToMonitor: any[]) {
  const newJobKeys = new Set()
  
  websitesToMonitor.forEach((project) => {
    project.websites.forEach((website: any) => {
      const jobKey = `${website.id}-${project.interval}`
      newJobKeys.add(jobKey)
      
      if (activeJobs.has(jobKey)) {
        return
      }
      
      let cronExpression: string

      switch (project.interval) {
        case 30:
          cronExpression = `*/30 * * * * *`
          break
        case 60:
          cronExpression = `0 * * * * *`
          break
        case 300:
          cronExpression = `0 */5 * * * *`
          break
        case 600:
          cronExpression = `0 */10 * * * *`
          break
        case 900:
          cronExpression = `0 */15 * * * *`
          break
        default:
          const minutes = Math.floor(project.interval / 60)
          cronExpression = `0 */${minutes} * * * *`
      }

      const job = new cron.CronJob(cronExpression, async () => {
        await monitorWebsite(website, project)
      })

      job.start()
      activeJobs.set(jobKey, job)
      console.log(`Started monitoring ${website.url} every ${project.interval} seconds (${cronExpression})`)
    })
  })
  
  activeJobs.forEach((job, key) => {
    if (!newJobKeys.has(key)) {
      job.stop()
      activeJobs.delete(key)
      console.log(`Stopped monitoring job: ${key}`)
    }
  })
}

async function monitorWebsite(website: any, project: any) {
  try {
    const startTime = Date.now()
    
    const response = await axios.get(website.url, {
      timeout: 10000,
      validateStatus: () => true
    })
    
    const responseTime = Date.now() - startTime
    const isHealthy = response.status >= 200 && response.status < 300

    const checkData = {
      status: isHealthy,
      responseTime: responseTime,
      statusCode: response.status,
      headers: response.headers,
      contentSize: response.data ? JSON.stringify(response.data).length : null,
      errorMessage: isHealthy ? null : `HTTP ${response.status}`,
      errorType: isHealthy ? null : 'http_error'
    }

    await checkWebsite(website.id, checkData)

    const performanceData = {
      responseTime: responseTime,
      statusCode: response.status,
      contentSize: response.data ? JSON.stringify(response.data).length : null
    }

    await createPerformanceMetric(website.id, performanceData)

    // Note: Website model doesn't have status, lastCheckAt, totalChecks, failedChecks, avgResponseTime fields
    // These statistics are calculated from the Check table instead

    if (isHealthy) {
      await updateProject(project.projectId, { 
        status: 'online'
      })
      console.log(`[${project.projectName}] ${website.url}: UP (${responseTime}ms) - Status: ${response.status}`)
    } else {
      await updateProject(project.projectId, { 
        status: 'offline'
      })
      await alertWebsite(website.id, {
        message: `Website ${website.url} is down`
      })
      console.log(`[${project.projectName}] ${website.url}: DOWN (${responseTime}ms) - Status: ${response.status}`)
    }

  } catch (error: any) {
    console.log(`[${project.projectName}] ${website.url}: ERROR - ${error.message}`)
    
    const errorType = error.code === 'ECONNABORTED' ? 'timeout' : 
                     error.code === 'ENOTFOUND' ? 'dns_error' : 
                     error.code === 'ECONNREFUSED' ? 'connection_refused' : 'network_error'

    await checkWebsite(website.id, {
      status: false,
      responseTime: null,
      statusCode: null,
      errorMessage: error.message,
      errorType: errorType
    })

    // Note: Website model doesn't have status, lastCheckAt, totalChecks, failedChecks fields
    // These statistics are calculated from the Check table instead

    await updateProject(project.projectId, { 
      status: 'offline'
    })
    await alertWebsite(website.id, {
      message: `Website ${website.url} is unreachable`
    })
  }
}

async function calculateDailyUptime() {
  try {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(0, 0, 0, 0)

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const websites = await findAllWebsites()
    
    for (const project of websites) {
      for (const website of project.Website) {
        const checks = await prisma.check.findMany({
          where: {
            websiteId: website.id,
            checkedAt: {
              gte: yesterday,
              lt: today
            }
          }
        })

        if (checks.length > 0) {
          const totalChecks = checks.length
          const successfulChecks = checks.filter(check => check.status).length
          const failedChecks = totalChecks - successfulChecks
          const uptime = (successfulChecks / totalChecks) * 100
          const downtime = 100 - uptime
          const avgResponseTime = checks.reduce((sum, check) => sum + (check.responseTime || 0), 0) / totalChecks

          await createUptimeLog(website.id, {
            date: yesterday,
            uptime,
            downtime,
            checks: totalChecks,
            failures: failedChecks,
            avgResponseTime
          })

          console.log(`Daily uptime for ${website.url}: ${uptime.toFixed(2)}%`)
        }
      }
    }
  } catch (error) {
    console.error('Error calculating daily uptime:', error)
  }
}

app.listen(8000, async () => {
  console.log('Server is running on port 8000')
  await main()
  startCron()
})
