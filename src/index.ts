import express from 'express';
import { checkWebsite, findAllWebsites, updateProject } from './lib/query.js';
import cron from 'cron';
import axios from 'axios';
const app = express();

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
      console.log(JSON.stringify(websites, null, 2))
      checkWebsites()
    }
  })
  job.start()
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
      timeout: 10000
    })
    const responseTime = Date.now() - startTime

    const isHealthy = response.status >= 200 && response.status < 300

    await checkWebsite(website.id, {
      status: isHealthy,
      responseTime: responseTime,
    })

    if (isHealthy) {
      await updateProject(project.projectId, { status: 'online' })
      console.log(`[${project.projectName}] ${website.url}: UP (${responseTime}ms)`)
    } else {
      await updateProject(project.projectId, { status: 'offline' })
      console.log(`[${project.projectName}] ${website.url}: DOWN (${responseTime}ms) - Status: ${response.status}`)
    }

  } catch (error) {
    console.log(`[${project.projectName}] ${website.url}: ERROR - ${error}`)
    await updateProject(project.projectId, { status: 'offline' })
    await checkWebsite(website.id, {
      status: false,
      responseTime: null,
      errorMessage: "Website is unreachable"
    })
  }
}





app.listen(8000, async () => {
  console.log('Server is running on port 8000')
  await main()
  startCron()
})
