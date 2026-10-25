import Ajv, { ValidateFunction } from "ajv";
import { Request, Response, NextFunction } from "express";
import addFormats from "ajv-formats";

const logger = {
    info: (msg: string) => console.log(`[INFO] ${msg}`),
    error: (msg: string, meta?: any) => console.error(`[ERROR] ${msg}`, meta),
};

const printData = (data: any) => JSON.stringify(data, null, 2);

// Initialize AJV instance
const ajv = new Ajv({
    messages: true,
    strict: false,
    allErrors: true,
    ownProperties: true,
    verbose: true,
});

addFormats(ajv);

// Cache compiled schemas for performance
const schemaCache = new Map<string, ValidateFunction<any>>();

export const validateSchema =
    (schema: any, type: string) => (req: Request, res: Response, next: NextFunction) => {
        try {
            // Retrieve from cache or compile
            const schemaKey = JSON.stringify(schema);
            let validate = schemaCache.get(schemaKey);
            if (!validate) {
                validate = ajv.compile(schema);
                schemaCache.set(schemaKey, validate);
            }

            const isValid = validate(type === "BODY" ? req.body : req.query);
            const validationErrors: any[] = [];
            if (!isValid) {
                logger.info(`[validateSchema] Validation errors: ${printData(validate.errors)}`);
                if (validate.errors) {
                    validate.errors.forEach((element: any) => {
                        if (element?.keyword === "enum") {
                            element.message = `Please pass proper value for field: ${element?.instancePath?.replace("/", "")}.`;
                        }

                        if (element?.keyword === "required") {
                            const keyword = element?.keyword;
                            const keyName = element?.params?.missingProperty;

                            element.message =
                                element?.parentSchema?.errorMessage?.[keyword]?.[keyName] ||
                                element?.message;
                        }

                        if (["boolean"].includes(element?.schema)) {
                            element.message = `${element?.parentSchema?.errorMessage?.type}`;
                        }

                        if (["uuid"].includes(element?.schema)) {
                            element.message = `${element?.parentSchema?.errorMessage?.format}`;
                        }

                        if (["additionalProperties"].includes(element?.keyword)) {
                            element.message = `${element?.message}: ${element?.params?.additionalProperty}`;
                        }

                        validationErrors.push({
                            instancePath: element.instancePath,
                            message: ["enum", "boolean"].includes(element?.keyword)
                                ? element?.message
                                : element?.parentSchema?.description || element?.message,
                        });
                    });
                }
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: validationErrors[0]?.message || "Validation Errors",
                    data: validationErrors,
                });
            } else {
                next();
            }
        } catch (error) {
            logger.error(`Error validating JSON schema`, error);

            return res.status(500).json({
                error: true,
                status: 500,
                message: "Error validating JSON Schema",
                data: {},
            });
        }
    };
