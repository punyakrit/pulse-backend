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


