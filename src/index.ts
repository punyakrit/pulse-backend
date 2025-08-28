import express from 'express';
import { checkWebsite, findAllWebsites, updateProject, createPerformanceMetric, createUptimeLog, alertWebsite } from './lib/query.js';
import cron from 'cron';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { Resend } from 'resend';

const app = express();
const prisma = new PrismaClient();

let websites: any[] = []
const resend = new Resend(process.env.RESEND_API_KEY);

let activeJobs: Map<string, cron.CronJob> = new Map()

async function main() {
  const response = await findAllWebsites()
  websites = response
  checkWebsites()
}


function startCron() {
  const job = new cron.CronJob('*/30 * * * * *', async () => {
    const response = await findAllWebsites()
    
    // More detailed change detection
    const hasChanges = JSON.stringify(response) !== JSON.stringify(websites)
    
    if (hasChanges) {
      console.log('Database changes detected!')
      console.log('Previous websites count:', websites.length)
      console.log('New websites count:', response.length)
      
      // Log URL changes for debugging
      response.forEach((project: any) => {
        project.Website.forEach((website: any) => {
          const oldProject = websites.find((p: any) => p.id === project.id)
          const oldWebsite = oldProject?.Website.find((w: any) => w.id === website.id)
          if (oldWebsite && oldWebsite.url !== website.url) {
            console.log(`URL changed for website ${website.id}: ${oldWebsite.url} -> ${website.url}`)
          }
        })
      })
      
      websites = response
      console.log('Updated websites:', websites.length, 'projects')
      checkWebsites()
    } else {
      console.log('No changes')
    }
  })
  job.start()

  const uptimeJob = new cron.CronJob('0 */30 * * * *', async () => {
    console.log('Calculating uptime statistics every 30 minutes...')
    await calculateUptime()
  })
  uptimeJob.start()
}



async function checkWebsites() {
  const websiteExists = websites.filter((website) => website.Website.length > 0)

  const websitesToMonitor = websiteExists
    .filter((project) => project.Setting?.status !== false)
    .map((project) => ({
      projectId: project.id,
      projectName: project.name,
      interval: project.Setting?.interval,
      notifyType: project.Setting?.notifyType,
      status: project.Setting?.status,
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
      const jobKey = `${website.id}-${website.url}-${project.interval}`
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
      console.log(`Started monitoring ${website.url} every ${project.interval} seconds (${cronExpression}) - Job Key: ${jobKey}`)
    })
  })
  
  activeJobs.forEach((job, key) => {
    if (!newJobKeys.has(key)) {
      job.stop()
      activeJobs.delete(key)
      console.log(`Stopped monitoring job: ${key}`)
    }
  })
  
  console.log(`Active jobs after update: ${activeJobs.size}`)
}

async function monitorWebsite(website: any, project: any) {
  try {
    const websiteExists = await prisma.website.findUnique({
      where: { id: website.id }
    })

    if (!websiteExists) {
      console.log(`[${project.projectName}] Website ${website.url} (ID: ${website.id}) no longer exists in database. Stopping monitoring.`)
      return
    }

    const projectSetting = await prisma.setting.findUnique({
      where: { projectId: project.projectId }
    })

    if (projectSetting?.status === false) {
      console.log(`[${project.projectName}] Monitoring is disabled for this project. Skipping check.`)
      return
    }

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

    if (isHealthy) {
      await updateProject(project.projectId, { 
        status: 'online'
      })
      
      await prisma.alert.updateMany({
        where: {
          websiteId: website.id,
          resolvedAt: null
        },
        data: {
          resolvedAt: new Date()
        }
      })
      
      console.log(`[${project.projectName}] ${website.url}: UP (${responseTime}ms) - Status: ${response.status}`)
    } else {
      const existingAlert = await prisma.alert.findFirst({
        where: {
          websiteId: website.id,
          resolvedAt: null
        }
      })

      if (!existingAlert) {
        await alertWebsite(website.id, {
          message: `Website ${website.url} is down`
        })
        
        await sendAlertEmail(website, project)
        console.log(`[${project.projectName}] ${website.url}: DOWN (${responseTime}ms) - Status: ${response.status} - Alert sent`)
      } else {
        console.log(`[${project.projectName}] ${website.url}: DOWN (${responseTime}ms) - Status: ${response.status} - Alert already exists`)
      }
    }

  } catch (error: any) {
    console.log(`[${project.projectName}] ${website.url}: ERROR - ${error.message}`)
    
    const websiteExists = await prisma.website.findUnique({
      where: { id: website.id }
    })

    if (!websiteExists) {
      console.log(`[${project.projectName}] Website ${website.url} (ID: ${website.id}) no longer exists in database. Stopping monitoring.`)
      return
    }
    
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

    const existingAlert = await prisma.alert.findFirst({
      where: {
        websiteId: website.id,
        resolvedAt: null
      }
    })

    if (!existingAlert) {
      await alertWebsite(website.id, {
        message: `Website ${website.url} is unreachable`
      })
      
      await sendAlertEmail(website, project)
      console.log(`[${project.projectName}] ${website.url}: ERROR - Alert sent`)
    } else {
      console.log(`[${project.projectName}] ${website.url}: ERROR - Alert already exists`)
    }
  }
}

async function calculateUptime() {
  try {
    console.log('Starting uptime calculation and database cleanup...')
    
    const fiveMinutesAgo = new Date()
    fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 30)

    const now = new Date()
    
    const oneDayAgo = new Date()
    oneDayAgo.setDate(oneDayAgo.getDate() - 1)

    const websites = await findAllWebsites()
    
    console.log('Cleaning up all check records...')
    const deletedChecks = await prisma.check.deleteMany({})
    console.log(`Deleted ${deletedChecks.count} check records`)
    
    console.log('Cleaning up all performance metrics...')
    const deletedMetrics = await prisma.performanceMetric.deleteMany({})
    console.log(`Deleted ${deletedMetrics.count} performance metrics`)
    
    for (const project of websites) {
      for (const website of project.Website) {
        const checks = await prisma.check.findMany({
          where: {
            websiteId: website.id,
            checkedAt: {
              gte: fiveMinutesAgo,
              lt: now
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
            date: fiveMinutesAgo,
            uptime,
            downtime,
            checks: totalChecks,
            failures: failedChecks,
            avgResponseTime
          })

          console.log(`30-minute uptime for ${website.url}: ${uptime.toFixed(2)}% (${totalChecks} checks)`)
        }
      }
    }
  } catch (error) {
    console.error('Error calculating uptime:', error)
  }
}


async function sendAlertEmail(website: any, project: any) {
  console.log("website", website)
  console.log("project", project)
  const getUserId = await prisma.project.findFirst({
    where: {
      id: project.projectId
    },
    select: {
      userId: true
    }
  })

  const userEmail = await prisma.user.findFirst({
    where: {
      id: getUserId?.userId || ''
    },
    select: {
      email: true
    }
  })

  console.log("userEmail", userEmail)
  
  const { data, error } = await resend.emails.send({
    from: 'alerts@pulse.punyakrit.dev',
    to: [userEmail?.email || ''],
    subject: `🚨 Alert: ${website.url} is down`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Website Alert</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            margin: 0;
            padding: 0;
            background-color: #f8fafc;
            color: #1e293b;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 12px;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            overflow: hidden;
            margin-top: 20px;
            margin-bottom: 20px;
          }
          .header {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            color: white;
            padding: 24px;
            text-align: center;
          }
          .header h1 {
            margin: 0;
            font-size: 24px;
            font-weight: 600;
          }
          .alert-icon {
            font-size: 48px;
            margin-bottom: 12px;
          }
          .content {
            padding: 32px 24px;
          }
          .status-badge {
            display: inline-block;
            background-color: #fef2f2;
            color: #dc2626;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 14px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            border: 1px solid #fecaca;
          }
          .website-info {
            background-color: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 20px;
            margin: 24px 0;
          }
          .info-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
          }
          .info-row:last-child {
            margin-bottom: 0;
          }
          .info-label {
            font-weight: 600;
            color: #64748b;
            font-size: 14px;
          }
          .info-value {
            font-weight: 500;
            color: #1e293b;
            font-size: 14px;
          }
          .url-display {
            background-color: #f1f5f9;
            padding: 12px;
            border-radius: 6px;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            font-size: 13px;
            color: #475569;
            word-break: break-all;
          }
          .timestamp {
            text-align: center;
            color: #64748b;
            font-size: 12px;
            margin-top: 24px;
            padding-top: 24px;
            border-top: 1px solid #e2e8f0;
          }
          .footer {
            background-color: #f8fafc;
            padding: 20px 24px;
            text-align: center;
            border-top: 1px solid #e2e8f0;
          }
          .footer p {
            margin: 0;
            color: #64748b;
            font-size: 12px;
          }
          .brand {
            color: #3b82f6;
            font-weight: 600;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="alert-icon">🚨</div>
            <h1>Website Alert</h1>
          </div>
          
          <div class="content">
            <div style="text-align: center; margin-bottom: 24px;">
              <span class="status-badge">Down</span>
            </div>
            
            <h2 style="margin: 0 0 16px 0; color: #1e293b; font-size: 18px;">
              Website is currently unavailable
            </h2>
            
            <p style="margin: 0 0 24px 0; color: #64748b; line-height: 1.6;">
              Our monitoring system has detected that the following website is not responding properly.
            </p>
            
            <div class="website-info">
              <div class="info-row">
                <span class="info-label">Project:</span>
                <span class="info-value">${project.projectName || 'Unknown Project'}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Status:</span>
                <span class="info-value" style="color: #dc2626; font-weight: 600;">Offline</span>
              </div>
              <div class="info-row">
                <span class="info-label">URL:</span>
              </div>
              <div class="url-display">${website.url}</div>
            </div>
            
            <div class="timestamp">
              Alert triggered at ${new Date().toLocaleString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                timeZoneName: 'short'
              })}
            </div>
          </div>
          
          <div class="footer">
            <p>
              This alert was sent by <span class="brand">Pulse</span> monitoring system
            </p>
            <p style="margin-top: 8px;">
              You can manage your alert preferences in your dashboard
            </p>
          </div>
        </div>
      </body>
      </html>
    `,
  });

  console.log("Alert Email Sent for ", website.url)
  if (error) {
    return console.error({ error });
  }
  

}

app.listen(8000, async () => {
  // await sendAlertEmail({url: 'https://www.google.com'}, {projectName: 'Google'})
  console.log('Server is running on port 8000')
  await main()
  startCron()
})
