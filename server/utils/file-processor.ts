import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface ProcessedFile {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  extractedText: string;
  uploadPath: string;
}

export class FileProcessor {
  private uploadDir: string;

  constructor(uploadDir: string = './uploads') {
    this.uploadDir = uploadDir;
    this.ensureUploadDir();
  }

  private ensureUploadDir() {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  async processFile(file: Express.Multer.File): Promise<ProcessedFile> {
    const fileId = uuidv4();
    const fileExtension = path.extname(file.originalname);
    const filename = `${fileId}${fileExtension}`;
    const uploadPath = path.join(this.uploadDir, filename);

    // Save file to disk
    fs.writeFileSync(uploadPath, file.buffer);

    let extractedText = '';

    try {
      if (file.mimetype === 'application/pdf') {
        extractedText = await this.extractPDFText(file.buffer);
      } else if (file.mimetype.startsWith('text/')) {
        extractedText = file.buffer.toString('utf-8');
      } else {
        throw new Error(`Unsupported file type: ${file.mimetype}`);
      }
    } catch (error) {
      // Clean up file if text extraction fails
      fs.unlinkSync(uploadPath);
      throw new Error(`Failed to process file: ${error.message}`);
    }

    return {
      id: fileId,
      filename,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      extractedText,
      uploadPath,
    };
  }

  private async extractPDFText(buffer: Buffer): Promise<string> {
    try {
      // Use dynamic import to avoid the test file issue
      const pdfParse = (await import('pdf-parse')).default;
      const data = await pdfParse(buffer);
      return data.text;
    } catch (error) {
      throw new Error(`PDF parsing failed: ${error.message}`);
    }
  }

  deleteFile(uploadPath: string): void {
    try {
      if (fs.existsSync(uploadPath)) {
        fs.unlinkSync(uploadPath);
      }
    } catch (error) {
      console.error('Failed to delete file:', error);
    }
  }

  validateFile(file: Express.Multer.File): { valid: boolean; error?: string } {
    const maxSize = parseInt(process.env.MAX_FILE_SIZE || '10485760'); // 10MB default
    const allowedTypes = ['application/pdf', 'text/plain', 'text/markdown'];

    if (file.size > maxSize) {
      return {
        valid: false,
        error: `File size exceeds maximum allowed size of ${maxSize / 1024 / 1024}MB`,
      };
    }

    if (!allowedTypes.includes(file.mimetype)) {
      return {
        valid: false,
        error: `File type ${file.mimetype} is not supported. Allowed types: PDF, TXT, MD`,
      };
    }

    return { valid: true };
  }

  cleanupOldFiles(maxAgeHours: number = 24): void {
    try {
      const files = fs.readdirSync(this.uploadDir);
      const now = Date.now();
      const maxAge = maxAgeHours * 60 * 60 * 1000;

      files.forEach((file) => {
        const filePath = path.join(this.uploadDir, file);
        const stats = fs.statSync(filePath);
        
        if (now - stats.mtime.getTime() > maxAge) {
          fs.unlinkSync(filePath);
          console.log(`Cleaned up old file: ${file}`);
        }
      });
    } catch (error) {
      console.error('Error cleaning up old files:', error);
    }
  }
}
