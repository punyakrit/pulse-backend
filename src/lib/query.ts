import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function findAllWebsites() {
    const projects = await prisma.project.findMany({
        include: {
            Website: true,
            Setting: true,
            
        }
    });
    return projects;
}


export async function updateProject(projectId: string, data: any) {
    const project = await prisma.project.update({
        where: { id: projectId },
        data
    });
    return project;
}


export async function checkWebsite(websiteId: string, data:any) {
    const check = await prisma.check.create({
        data: {
            websiteId: websiteId,
            ...data
        }
    });
    return check;
}