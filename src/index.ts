import express from 'express';
import { findAllWebsites } from './lib/query.js';
import cron from 'cron';
const app = express();

let websites: any[] = []

async function main() {
  
  const response = await findAllWebsites()
  websites = response
  // console.log(JSON.stringify(websites, null, 2))
  checkWebsites()

}


function startCron() {
  const job = new cron.CronJob('*/30 * * * * *', async () => {
    const response = await findAllWebsites()
    if(JSON.stringify(response) === JSON.stringify(websites)) {
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
    interval: project.Setting?.interval ,
    notifyType: project.Setting?.notifyType ,
    websites: project.Website.map((website: any) => ({
      id: website.id,
      url: website.url
    }))
  }))

  console.log('Websites to monitor:', websitesToMonitor)
  
  // setupMonitoringJobs(websitesToMonitor)
}

// function setupMonitoringJobs(websitesToMonitor: any[]) {
//   websitesToMonitor.forEach((project) => {
//     project.websites.forEach((website: any) => {
//       const cronExpression = `0 */${Math.floor(project.interval / 60)} * * * *`
      
//       const job = new cron.CronJob(cronExpression, async () => {
//         await monitorWebsite(website, project)
//       })
      
//       job.start()
//       console.log(`Started monitoring ${website.url} every ${project.interval} seconds`)
//     })
//   })
// }

// async function monitorWebsite(website: any, project: any) {
//   try {
//     const startTime = Date.now()
//     const response = await fetch(website.url, { 
//       method: 'GET',
//       // timeout: 10000 
//     })
//     const responseTime = Date.now() - startTime
    
//     const isHealthy = response.ok
    
//     console.log(`[${project.projectName}] ${website.url}: ${isHealthy ? 'UP' : 'DOWN'} (${responseTime}ms)`)
    
//     if (!isHealthy) {
//       console.log(`Alert: ${website.url} is down!`)
//     }
    
//   } catch (error) {
//     console.log(`[${project.projectName}] ${website.url}: ERROR - ${error}`)
//     console.log(`Alert: ${website.url} is unreachable!`)
//   }
// }





app.listen(3000, async () => {
  console.log('Server is running on port 3000')
  await main()
  startCron()
})
