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

  const uptimeJob = new cron.CronJob('0 */5 * * * *', async () => {
    console.log('Calculating uptime statistics every 5 minutes...')
    await calculateUptime()
  })
  uptimeJob.start()
}



async function checkWebsites() {
  const websiteExists = websites.filter((website) => website.Website.length > 0)

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
      
      // Resolve any existing alerts when website comes back online
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

   
    await alertWebsite(website.id, {
      message: `Website ${website.url} is unreachable`
    })
    
    // Note: We don't resolve alerts here because the website is still down
    // Alerts will be resolved when the website comes back online
  }
}

async function calculateUptime() {
  try {
    const fiveMinutesAgo = new Date()
    fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 5)

    const now = new Date()

    const websites = await findAllWebsites()
    
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

          console.log(`5-minute uptime for ${website.url}: ${uptime.toFixed(2)}% (${totalChecks} checks)`)
        }
      }
    }
  } catch (error) {
    console.error('Error calculating uptime:', error)
  }
}


async function sendAlertEmail(website: any, project: any) {
  const { data, error } = await resend.emails.send({
    from: 'jaat.cp@gmail.com',
    to: ['punyakritsinghmakhni@gmail.com'],
    subject: `Website ${website.url} is down`,
    html: `<strong>Website ${website.url} is down</strong>`,
  });

  if (error) {
    return console.error({ error });
  }
  

}

app.listen(8000, async () => {
  await sendAlertEmail({url: 'https://www.google.com'}, {projectName: 'Google'})
  console.log('Server is running on port 8000')
  // await main()
  // startCron()
})
