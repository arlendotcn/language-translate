import { ls } from './locales.js';
import { consoleError, consoleLog, consoleSuccess, filterJson, flattenObject, isFilePath, mergeJson, splitJson, unflattenObject } from './utils.js';
import { IncrementalMode, Lang } from './types.js';
import { getTranslator } from './translators.js';
import fs from 'fs';
import path from 'path';
import prettier from 'prettier';
export const translate = async ({ input, output, fromLang, targetLang, toolsLang = 'zh-CN', proxy, apiKeyConfig, incrementalMode, translateRuntimeDelay = 0, translateRuntimeChunkSize = 5, translateRuntimeMergeEnabled = true, mergeEnabledChunkValuesLength = 5000, ignoreValuesAndCopyToTarget = [], excludeFilesByIncludes = [], reservedKeywords = [/\{\{.+?}}/], excludeKeysByContentIncludes = [/\{\{.+?}}/] }) => {
    if (!isFilePath(input)) {
        return;
    }
    const translator = getTranslator({
        fromLang,
        targetLang,
        proxy,
        toolsLang,
        apiKeyConfig
    });
    let inputStartStr = '';
    // ------readSourceJson start-------
    let sourceText;
    try {
        sourceText = fs.readFileSync(input, 'utf8');
        if (sourceText.includes('export') && !input.endsWith('.json')) {
            inputStartStr = sourceText.slice(0, sourceText.indexOf('export'));
            sourceText = sourceText.slice(sourceText.indexOf('export'));
        }
        inputStartStr += sourceText.slice(0, sourceText.indexOf('{'));
    }
    catch (error) {
        consoleError(`${ls[toolsLang].checkFromPath}\n path ---> ${input}\n${String(error)}`);
        return;
    }
    sourceText = sourceText.slice(sourceText.indexOf('{'), sourceText.lastIndexOf('}') + 1);
    // eslint-disable-next-line prefer-const
    let sourceJson = {};
    sourceText = 'sourceJson = ' + sourceText;
    try {
        // eslint-disable-next-line no-eval
        eval(`(${sourceText})`);
    }
    catch (error) {
        consoleError(`${ls[toolsLang].sourceErr}\npath ---> ${input}\n${String(error)}`);
        return;
    }
    if (Object.keys(sourceJson).length === 0) {
        consoleError(ls[toolsLang].sourceNull);
        return;
    }
    // ------readSourceJson end-------
    const translateRun = async (jsonObj, isMergeEnable = false) => {
        const resJsonObj = {};
        const splitter = '\n[_]\n';
        for (const key in jsonObj) {
            let text = jsonObj[key];
            let a = text.split(splitter);
            const oSkipped = { length: 0 };
            const oReserved = { length: 0 };
            let resText = '';
            const ignore = excludeFilesByIncludes.findIndex(v => {
                if (v === '' || v === null)
                    return false;
                if (v === text)
                    return true;
                if (v instanceof RegExp)
                    return v.test(text);
                if (v instanceof Function)
                    return v(text);
                return false;
            }) > -1;
            if (ignore) {
                resText = text;
            }
            else {
                // 添加跳过 字段内容 包含特定字符串或匹配正则或者函数的 字段
                if (excludeKeysByContentIncludes !== undefined && (excludeKeysByContentIncludes.length > 0)) {
                    for (let i = 0, j = a.length; i < j; i++) {
                        const v = a[i];
                        if (v === '')
                            continue;
                        if (excludeKeysByContentIncludes.findIndex(x => {
                            if (v === '' || v === null)
                                return false;
                            if (x === v)
                                return true;
                            if (x instanceof RegExp)
                                return x.test(v);
                            if (x instanceof Function)
                                return x(v);
                            return false;
                        }) > -1) {
                            oSkipped[i] = v;
                            oSkipped.length++;
                            a[i] = '-';
                        }
                    }
                    if (oSkipped.length > 0)
                        text = a.join(splitter);
                }
                // 查找并标记保留字
                if (reservedKeywords !== undefined && (reservedKeywords.length > 0)) {
                    for (let i = 0, j = a.length; i < j; i++) {
                        const v = a[i];
                        const changes = {};
                        let n = 0;
                        if (v === '' || v === null)
                            continue;
                        reservedKeywords.forEach(x => {
                            if (x instanceof RegExp ? !x.test(v) : x !== '' && !v.includes(x))
                                return;
                            let key = '';
                            const value = [];
                            a[i] = v.replace(x, vv => {
                                if (key === '')
                                    key = `AR0Z${i}AR1Z${n++}AR2Z`;
                                value.push(vv);
                                changes[key] = value;
                                return key;
                            });
                        });
                        if (n > 0) {
                            oReserved[i] = changes;
                            oReserved.length++;
                        }
                    }
                    if (oReserved.length > 0)
                        text = a.join(splitter);
                }
            }
            if (!ignore)
                resText = await translator(text);
            // 还原 被跳过的原始语句
            if (oSkipped.length > 0) {
                delete oSkipped.length;
                a = resText.split(splitter);
                Object.keys(oSkipped).forEach(key => { a[parseInt(key)] = oSkipped[key]; });
                resText = a.join(splitter);
            }
            // 还原 保留关键字
            if (oReserved.length > 0) {
                delete oReserved.length;
                Object.keys(oReserved).forEach(n => {
                    Object.keys(oReserved[n]).forEach(k => {
                        for (const v of oReserved[n][k])
                            resText = resText.replace(k, v);
                    });
                });
            }
            if (translateRuntimeDelay > 0 && !ignore) {
                consoleLog(`delay ${translateRuntimeDelay}ms`);
                await new Promise((resolve) => setTimeout(resolve, translateRuntimeDelay));
            }
            isMergeEnable || consoleSuccess(`${fromLang}: ${text} --${ignore ? '(with ignore copy)-' : ''}-> ${targetLang}: ${resText}`);
            resJsonObj[key] = resText;
        }
        return resJsonObj;
    };
    // ------read out json start-----
    let startStr = '';
    let funValues = [];
    let outFile;
    let outTextJson = {};
    const readOutFile = () => {
        try {
            outFile = fs.readFileSync(output, 'utf8');
            try {
                if (outFile.includes('export') && !output.endsWith('.json')) {
                    startStr = outFile.slice(0, outFile.indexOf('export'));
                    outFile = outFile.slice(outFile.indexOf('export'));
                }
                startStr += outFile.slice(0, outFile.indexOf('{'));
                outFile = outFile.slice(outFile.indexOf('{'), outFile.lastIndexOf('}') + 1);
                outFile = outFile.replace(/['"`a-zA-Z0-9_]+:.*(\(.+\).*=>|function[\s\S]+?return)[\s\S]+?,\n/g, (v) => {
                    funValues.push(v);
                    return '';
                });
                outFile = 'outTextJson = ' + outFile;
                // eslint-disable-next-line no-eval
                eval(`(${outFile})`);
            }
            catch (error) {
                consoleError(`${ls[toolsLang].targetErr}\n path ---> ${output}\n${String(error)}`);
                return true;
            }
        }
        catch (error) {
            // readFileSync error
        }
        return false;
    };
    if (incrementalMode === IncrementalMode.fast) {
        if (readOutFile()) {
            return;
        }
    }
    const transJson = incrementalMode === IncrementalMode.fast
        ? filterJson(sourceJson, outTextJson)
        : sourceJson;
    if (incrementalMode === IncrementalMode.fast && Object.keys(transJson).length === 0) {
        // no new key
        return;
    }
    // ------read out json end-----
    let outTipMsg = '';
    const outJsonToFile = async (resJson) => {
        startStr = '';
        funValues = [];
        outFile = null;
        outTextJson = {};
        if (readOutFile()) {
            return;
        }
        let outPutBuffer = (outFile != null ? startStr : inputStartStr) + '{';
        funValues.forEach((item) => {
            outPutBuffer += `${item}`;
        });
        if (outFile != null) {
            outPutBuffer += JSON.stringify(mergeJson(outTextJson, resJson)).slice(1);
            outPutBuffer = await prettier.format(outPutBuffer, { parser: output.endsWith('.json') ? 'json' : 'typescript' });
            fs.writeFileSync(output, outPutBuffer);
            if (outTipMsg.length === 0) {
                outTipMsg = `${ls[toolsLang].patchSuccess} --> ${output}`;
            }
        }
        else {
            outPutBuffer += JSON.stringify(resJson).slice(1);
            outPutBuffer = await prettier.format(outPutBuffer, { parser: output.endsWith('.json') ? 'json' : 'typescript' });
            const outDirname = path.dirname(output);
            fs.existsSync(outDirname) || fs.mkdirSync(outDirname, { recursive: true });
            fs.writeFileSync(output, outPutBuffer);
            if (outTipMsg.length === 0) {
                outTipMsg = `${ls[toolsLang].createSuccess} --> ${output}`;
            }
        }
    };
    const fragments = splitJson(transJson);
    if (translateRuntimeMergeEnabled) {
        let chunkValuesLength = 0;
        let keys = [];
        let values = [];
        const chunks = [];
        fragments.forEach((it, idx) => {
            const flattenIt = flattenObject(it);
            const flattenItVlasLen = Object.values(flattenIt).reduce((pre, cur) => pre + cur.length, 0);
            if (flattenItVlasLen + chunkValuesLength + 14 >= mergeEnabledChunkValuesLength) {
                chunks.push([keys, values]);
                chunkValuesLength = 0;
                keys = [];
                values = [];
            }
            chunkValuesLength += (flattenItVlasLen + 14);
            Object.entries(flattenIt).forEach(([key, val]) => {
                keys.push(key);
                values.push(val);
            });
        });
        if (keys.length > 0) {
            chunks.push([keys, values]);
            chunkValuesLength = 0;
            keys = [];
            values = [];
        }
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const prepareInputJson = { text: chunk[1].join(targetLang === Lang.te ? '\n###\n' : '\n[_]\n') };
            const prepareOutJson = {};
            const resJson = await translateRun(prepareInputJson, true);
            const outValues = resJson.text.split(targetLang === Lang.te ? /\n *# *# *# *\n/ : /\n *\[ *_ *\] *\n/).map((v) => v.trim());
            if (chunk[1].length !== outValues.length) {
                consoleError(`${ls[toolsLang].translateRuntimeMergeEnabledErr}${targetLang}`);
                consoleError(`input values length: ${chunk[1].length} --- output values length: ${outValues.length}`);
                consoleError(`input values ---> ${chunk[1].toString().slice(0, 100)}... ...\n output values ---> ${outValues.toString().slice(0, 100)}... ...`);
                return;
            }
            chunk[0].forEach((key, idx) => {
                const ignore = excludeFilesByIncludes.includes(chunk[1][idx]);
                if (ignore) {
                    outValues[idx] = chunk[1][idx];
                }
                consoleSuccess(`${fromLang}: ${chunk[1][idx]} --${ignore ? '(with ignore copy)-' : ''}-> ${targetLang}: ${outValues[idx]}`);
                prepareOutJson[key] = outValues[idx];
            });
            const outJson = unflattenObject(prepareOutJson);
            await outJsonToFile(outJson);
        }
    }
    else {
        let chunkJson = null;
        const chunks = [];
        fragments.forEach((it, idx) => {
            if (idx % translateRuntimeChunkSize === 0) {
                chunkJson !== null && chunks.push(chunkJson);
                chunkJson = it;
            }
            else if (chunkJson !== null) {
                chunkJson = mergeJson(chunkJson, it);
            }
        });
        if (chunkJson !== null && Object.keys(chunkJson).length > 0) {
            chunks.push(chunkJson);
            chunkJson = null;
        }
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const resJson = await translateRun(chunk);
            await outJsonToFile(resJson);
        }
    }
    consoleLog(outTipMsg);
};
